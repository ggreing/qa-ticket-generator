/** Notion PRD provider: page + blocks to Markdown, depth 3, max 500 blocks (PRD-05). Owner: qa-work-session-a. */
import {
  type BlockObjectResponse,
  Client,
  isFullBlock,
  isFullPage,
  isHTTPResponseError,
  RequestTimeoutError,
} from '@notionhq/client';
import type { PrdDocument, PrdProvider } from '../../core/contracts';
import { mapLimit } from '../retry';
import { extractAcceptanceCriteria } from './ac';
import { PrdFetchError } from './errors';
import { type NotionNode, notionToMarkdown } from './notion-to-md';

/** Test seams and limits. */
export interface NotionDeps {
  /** Replaces the HTTP layer of the Notion client (tests). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Max nesting depth fetched (default 3: top-level blocks are depth 1). */
  maxDepth?: number;
  /** Max blocks fetched per page (default 500). */
  maxBlocks?: number;
  /** Parallel child-list requests (default 3, Notion's average rate limit is ~3 req/s). */
  concurrency?: number;
}

const PAGE_ID = /^[0-9a-f]{32}$/;
/** Children of these blocks are separate documents (or nothing useful); never descend. */
const NO_DESCEND = new Set<BlockObjectResponse['type']>(['child_page', 'child_database', 'unsupported']);

function pageTitle(page: unknown): string {
  if (!isFullPage(page as Parameters<typeof isFullPage>[0])) return '';
  const props = Object.values((page as { properties: Record<string, unknown> }).properties);
  for (const prop of props) {
    const p = prop as { type?: string; title?: { plain_text?: string }[] };
    if (p.type === 'title' && Array.isArray(p.title))
      return p.title
        .map((t) => t.plain_text ?? '')
        .join('')
        .trim();
  }
  return '';
}

function toFetchError(err: unknown, id: string): unknown {
  if (err instanceof PrdFetchError) return err;
  if (RequestTimeoutError.isRequestTimeoutError(err)) {
    return new PrdFetchError('http', `Notion request for page ${id} timed out.`);
  }
  if (isHTTPResponseError(err)) {
    const status = err.status;
    // PRD-10 — 401/403/404 are all fixed in the user's Notion integration settings.
    if (status === 401) {
      return new PrdFetchError(
        'permission',
        'Notion rejected the integration token (HTTP 401); create a new internal integration secret and update notion-token.',
        { status },
      );
    }
    if (status === 403) {
      return new PrdFetchError(
        'permission',
        `The Notion integration may not read page ${id} (HTTP 403); enable the "Read content" capability for the integration.`,
        { status },
      );
    }
    if (status === 404) {
      // Notion answers 404 for pages the integration was not invited to.
      return new PrdFetchError(
        'permission',
        `Notion page ${id} is not shared with the integration (HTTP 404); add the integration under the page's "Connections".`,
        { status },
      );
    }
    return new PrdFetchError('http', `Notion request for page ${id} failed (HTTP ${status}).`, { status });
  }
  return err;
}

/**
 * Fetches the block tree breadth-first: every level is fully listed before the next one, so the
 * block budget keeps the shallowest content and the result does not depend on response timing.
 */
async function fetchTree(
  client: Client,
  pageId: string,
  limits: { maxDepth: number; maxBlocks: number; concurrency: number },
  signal: AbortSignal,
): Promise<{ nodes: NotionNode[]; count: number; truncated: boolean }> {
  const root: NotionNode[] = [];
  let level: { id: string; into: NotionNode[] }[] = [{ id: pageId, into: root }];
  let count = 0;
  let truncated = false;

  for (let depth = 1; depth <= limits.maxDepth && level.length > 0; depth++) {
    const budgetAtStart = limits.maxBlocks - count;
    const lists = await mapLimit(level, limits.concurrency, async ({ id }) => {
      const blocks: BlockObjectResponse[] = [];
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const res = await client.blocks.children.list({
          block_id: id,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        for (const b of res.results) if (isFullBlock(b)) blocks.push(b);
        cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
        if (cursor && blocks.length >= budgetAtStart) {
          truncated = true;
          cursor = undefined;
        }
      } while (cursor);
      return blocks;
    });

    const next: typeof level = [];
    level.forEach((parent, i) => {
      for (const block of lists[i] ?? []) {
        if (count >= limits.maxBlocks) {
          truncated = true;
          return;
        }
        count++;
        const node: NotionNode = { block, children: [] };
        parent.into.push(node);
        if (block.has_children && !NO_DESCEND.has(block.type)) {
          if (depth < limits.maxDepth) next.push({ id: block.id, into: node.children });
          else truncated = true;
        }
      }
    });
    level = next;
  }
  return { nodes: root, count, truncated };
}

/**
 * PRD-05 — Notion provider (`@notionhq/client` v5). Reads the page title from its `title`
 * property and converts the block tree to Markdown, recursing to depth 3 and stopping at 500
 * blocks. Acceptance criteria are extracted from the Markdown (PRD-07).
 *
 * @param token Notion integration token, or null when Notion is not configured (PRD-09).
 * @param deps Optional `fetch` override and limits for tests.
 */
export function createNotionProvider(token: string | null, deps: NotionDeps = {}): PrdProvider {
  const limits = {
    maxDepth: deps.maxDepth ?? 3,
    maxBlocks: deps.maxBlocks ?? 500,
    concurrency: Math.max(1, deps.concurrency ?? 3),
  };
  const baseFetch = deps.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));

  return {
    source: 'notion',
    isConfigured: () => token !== null && token !== '',
    async fetch(ref, signal): Promise<PrdDocument> {
      if (!token) throw new PrdFetchError('invalid_ref', 'Notion is not configured.');
      const id = ref.id.replace(/-/g, '').toLowerCase();
      if (!PAGE_ID.test(id))
        throw new PrdFetchError('invalid_ref', 'The reference is not a valid Notion page id.');

      // The client takes no AbortSignal, so bind the run's signal into its HTTP layer.
      const client = new Client({
        auth: token,
        fetch: (url, init) => baseFetch(url, { ...(init as RequestInit), signal }),
        logger: () => undefined, // its warnings can include response bodies (OBS-01)
        retry: { maxRetries: 2, initialRetryDelayMs: 500, maxRetryDelayMs: 5_000 },
      });

      try {
        const page = await client.pages.retrieve({ page_id: id });
        const tree = await fetchTree(client, id, limits, signal);
        const body = notionToMarkdown(tree.nodes);
        const bodyMarkdown = tree.truncated
          ? `${body}\n\n_(Truncated: Notion content deeper than ${limits.maxDepth} levels or beyond ${limits.maxBlocks} blocks was not read.)_`
          : body;
        const url = (page as { url?: unknown }).url;
        return {
          ref,
          title: pageTitle(page) || 'Untitled',
          bodyMarkdown,
          acceptanceCriteria: extractAcceptanceCriteria(body),
          url: typeof url === 'string' && url ? url : (ref.url ?? `https://www.notion.so/${id}`),
          meta: {
            pageId: id,
            blocks: String(tree.count),
            ...(tree.truncated ? { truncated: 'true' } : {}),
          },
        };
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        throw toFetchError(err, id);
      }
    },
  };
}
