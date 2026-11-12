import { describe, expect, it } from 'vitest';
import { PrdFetchError } from '../../../src/context/prd/errors';
import { createNotionProvider, type NotionDeps } from '../../../src/context/prd/notion';
import type { PrdRef } from '../../../src/core/contracts';
import { fakeFetch, fixture, hang, json, type RecordedRequest } from '../helpers';

const PAGE = '0123456789abcdef0123456789abcdef';
const ref = (id = PAGE): PrdRef => ({ source: 'notion', id, raw: `https://www.notion.so/${id}` });
const signal = () => new AbortController().signal;

interface NotionFixture {
  page: Record<string, unknown>;
  children: Record<string, unknown[]>;
}

/** Minimal Notion API: pages.retrieve + paginated blocks.children.list. */
function notionApi(data: NotionFixture, override?: (req: RecordedRequest) => Response | undefined) {
  return fakeFetch((req) => {
    const hit = override?.(req);
    if (hit) return hit;
    const path = req.url.pathname;
    const page = path.match(/^\/v1\/pages\/([^/]+)$/);
    if (page) {
      return page[1]?.replace(/-/g, '') === PAGE
        ? json(data.page)
        : json({ object: 'error', status: 404, code: 'object_not_found', message: 'nope' }, 404);
    }
    const kids = path.match(/^\/v1\/blocks\/([^/]+)\/children$/);
    if (kids?.[1]) {
      const all = data.children[kids[1].replace(/-/g, '') === PAGE ? PAGE : kids[1]] ?? [];
      const size = Number(req.url.searchParams.get('page_size') ?? 100);
      const start = Number(req.url.searchParams.get('start_cursor') ?? 0);
      const results = all.slice(start, start + size);
      const more = start + size < all.length;
      return json({
        object: 'list',
        type: 'block',
        block: {},
        results,
        has_more: more,
        next_cursor: more ? String(start + size) : null,
      });
    }
    return json({ object: 'error', status: 400, code: 'invalid_request_url', message: 'bad' }, 400);
  });
}

function provider(api: ReturnType<typeof notionApi>, deps: Partial<NotionDeps> = {}) {
  return createNotionProvider('secret_notion_token', { fetch: api.fetch, ...deps });
}

describe('createNotionProvider', () => {
  it('PRD-09 is unconfigured without a token', async () => {
    expect(createNotionProvider(null).isConfigured()).toBe(false);
    expect(createNotionProvider('').isConfigured()).toBe(false);
    expect(createNotionProvider('t').source).toBe('notion');
    await expect(createNotionProvider(null).fetch(ref(), signal())).rejects.toBeInstanceOf(PrdFetchError);
  });

  it('PRD-05 converts the synthetic page: title property, blocks to Markdown, AC', async () => {
    const api = notionApi(fixture<NotionFixture>('notion/page-coupon.json'));
    const doc = await provider(api).fetch(ref(), signal());
    expect(doc.title).toBe('Coupon PRD');
    expect(doc.url).toBe(`https://www.notion.so/acme/Coupon-at-checkout-${PAGE}`);
    expect(doc.bodyMarkdown).toMatchInlineSnapshot(`
      "# Coupon at checkout

      Shoppers apply a **coupon code** — see [pricing](https://example.com/pricing) and \`apply()\`. Formula $p \\times 0.9$

      ## Acceptance Criteria

      - [ ] A coupon applies once per order
      - [x] Expired coupons are rejected
      - Edge cases
        - Zero-amount orders

      ## Rollout

      1. Staff
      2. Everyone

      - Level 1
        - Level 2
          - Level 3

      > _No stacking._

      > 🚩 Behind a flag

      \`\`\`json
      { "code": "SAVE10" }
      \`\`\`

      \`\`\`
      plain
      \`\`\`

      ---

      $$
      E = mc^2
      $$

      | Code | Discount |
      | --- | --- |
      | SAVE10 | 10% \\| max 5 |

      [Sub-page: Old drafts]

      [Database: Coupons DB]

      [image: Checkout mock]

      [Research](https://example.com/research)

      https://example.com/embed

      https://example.com/preview

      Column text

      ### Notes

      #### Tiny heading

      Template text

      _(Truncated: Notion content deeper than 3 levels or beyond 500 blocks was not read.)_"
    `);
    expect(doc.acceptanceCriteria).toEqual([
      'A coupon applies once per order',
      'Expired coupons are rejected',
      'Edge cases; Zero-amount orders',
    ]);
    expect(api.calls[0]?.headers.authorization).toBe('Bearer secret_notion_token');
    expect(doc.meta).toMatchObject({ pageId: PAGE, truncated: 'true' });
  });

  it('PRD-05 recurses to depth 3 only and never into sub-pages', async () => {
    const data = fixture<NotionFixture>('notion/page-coupon.json');
    const api = notionApi(data);
    const doc = await provider(api).fetch(ref(), signal());
    const listed = api.calls.map((c) => c.url.pathname).filter((p) => p.endsWith('/children'));
    const blockWith = (text: string) =>
      Object.values(data.children)
        .flat()
        .find((b) => JSON.stringify(b).includes(text)) as { id: string };
    expect(listed).not.toContain(`/v1/blocks/${blockWith('Level 3').id}/children`);
    expect(listed).not.toContain(`/v1/blocks/${blockWith('Old drafts').id}/children`);
    expect(doc.bodyMarkdown).toContain('Level 3');
    expect(doc.bodyMarkdown).not.toContain('Level 4');
    expect(doc.bodyMarkdown).not.toContain('Must not be fetched');
    // Signed file URLs never reach the prompt.
    expect(doc.bodyMarkdown).not.toContain('X-Amz-Signature');
  });

  it('PRD-05 paginates block children and stops at 500 blocks', async () => {
    const para = (i: number) => ({
      object: 'block',
      id: `b-${i}`,
      type: 'paragraph',
      has_children: false,
      paragraph: { rich_text: [{ type: 'text', plain_text: `p${i}`, href: null }] },
    });
    const data: NotionFixture = {
      page: { object: 'page', id: PAGE, url: `https://www.notion.so/${PAGE}`, properties: {} },
      children: { [PAGE]: Array.from({ length: 650 }, (_, i) => para(i)) },
    };
    const api = notionApi(data);
    const doc = await provider(api).fetch(ref(), signal());
    expect(doc.meta).toEqual({ pageId: PAGE, blocks: '500', truncated: 'true' });
    expect(doc.title).toBe('Untitled');
    expect(doc.bodyMarkdown).toContain('p499');
    expect(doc.bodyMarkdown).not.toContain('p500');
    expect(doc.bodyMarkdown).toMatch(/Truncated/);
    // 5 pages of 100 cover the budget; the 6th and 7th are never requested.
    expect(api.calls.filter((c) => c.url.pathname.endsWith('/children'))).toHaveLength(5);

    const small = notionApi({ ...data, children: { [PAGE]: data.children[PAGE]?.slice(0, 150) ?? [] } });
    const smallDoc = await provider(small).fetch(ref(), signal());
    expect(smallDoc.meta).toEqual({ pageId: PAGE, blocks: '150' });
    expect(smallDoc.bodyMarkdown).not.toMatch(/Truncated/);
  });

  it('PRD-05 honours custom limits and skips partial blocks', async () => {
    const data: NotionFixture = {
      page: {
        object: 'page',
        id: PAGE,
        url: '',
        properties: { T: { type: 'title', title: [{ plain_text: 'T' }] } },
      },
      children: {
        [PAGE]: [
          { object: 'block', id: 'partial' },
          {
            object: 'block',
            id: 'x',
            type: 'toggle',
            has_children: true,
            toggle: { rich_text: [{ type: 'text', plain_text: 'top', href: null }] },
          },
        ],
        x: [
          {
            object: 'block',
            id: 'y',
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: [{ type: 'text', plain_text: 'child', href: null }] },
          },
        ],
      },
    };
    const doc = await provider(notionApi(data), { maxDepth: 1, concurrency: 1 }).fetch(
      { ...ref(), url: 'https://acme.notion.site/x' },
      signal(),
    );
    expect(doc.bodyMarkdown.startsWith('- top')).toBe(true);
    expect(doc.bodyMarkdown).not.toContain('child');
    expect(doc.url).toBe('https://acme.notion.site/x');
    expect(doc.title).toBe('T');
  });

  it('PRD-08/PRD-10 maps 401/403/404 to permission with a fix, and 400 to a safe error', async () => {
    const data = fixture<NotionFixture>('notion/page-coupon.json');
    const cases: [number, string, PrdFetchError['kind'], string][] = [
      [401, 'unauthorized', 'permission', 'update notion-token'],
      [403, 'restricted_resource', 'permission', 'Read content'],
      [404, 'object_not_found', 'permission', 'Connections'],
      [400, 'validation_error', 'http', 'failed'],
    ];
    for (const [status, code, kind, hint] of cases) {
      const api = notionApi(data, () =>
        json({ object: 'error', status, code, message: 'SECRET BODY' }, status),
      );
      const err = (await provider(api)
        .fetch(ref(), signal())
        .catch((e: unknown) => e)) as PrdFetchError;
      expect(err, String(status)).toBeInstanceOf(PrdFetchError);
      expect(err.kind).toBe(kind);
      expect(err.message).toContain(`HTTP ${status}`);
      expect(err.message).toContain(hint);
      expect(err.message).not.toContain('SECRET');
      expect(err.message).not.toContain('secret_notion_token');
    }
  });

  it('PRD-08 rejects ids that are not Notion page ids', async () => {
    const api = notionApi(fixture<NotionFixture>('notion/page-coupon.json'));
    await expect(provider(api).fetch(ref('../../etc'), signal())).rejects.toMatchObject({
      kind: 'invalid_ref',
    });
    expect(api.calls).toHaveLength(0);
    // Dashed UUIDs are accepted.
    await expect(
      provider(api).fetch(ref('01234567-89ab-cdef-0123-456789abcdef'), signal()),
    ).resolves.toMatchObject({
      title: 'Coupon PRD',
    });
  });

  it('PRD-08 aborts in-flight requests when the signal fires', async () => {
    const api = notionApi(
      fixture<NotionFixture>('notion/page-coupon.json'),
      () => hang() as unknown as Response,
    );
    const ctrl = new AbortController();
    const p = provider(api).fetch(ref(), ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
