/** Jira case sink: one Sub-task per case under the spec story (SPEC v3 §4, §5). Owner: qa-work-session-a. */

import { type AdfNode, adfToMarkdown } from '../context/prd/adf-to-md';
import { type RetryOptions, withRetry } from '../context/retry';
import type {
  CaseSetSummary,
  CaseSink,
  ExistingCaseTicket,
  QaCase,
  RenderedCase,
  SinkContext,
} from '../core/cases';
import type { Language, PrdRef } from '../core/contracts';
import { QtgError } from '../core/errors';
import {
  areaDigest,
  CASE_LABEL,
  decodePayload,
  encodePayload,
  OBSOLETE_TICKET_LABEL,
  obsoleteTitle,
  type SinkPayload,
  sinkError,
  suggestMarker,
  summaryLines,
  summaryMarker,
  ticketFrom,
} from './common';
import { adfText, markdownToAdf } from './md-to-adf';

export interface JiraCaseSinkOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  subtaskType: string;
}

export interface JiraCaseSinkDeps {
  fetch?: typeof fetch;
  retry?: RetryOptions;
}

/** §5 — P0 is the highest priority the default Jira scheme offers. */
const PRIORITY_NAME = { P0: 'Highest', P1: 'High', P2: 'Medium' } as const;
const PAYLOAD_TITLE = 'qtg data (do not edit)';
const SUMMARY_LIMIT = 255;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const FIELDS = ['summary', 'description', 'labels', 'status', 'assignee', 'creator'];

const PROPOSED: Record<Language, { heading: string; note: string }> = {
  en: {
    heading: 'Tool-proposed change',
    note: 'This sub-task was edited by hand, so the tool did not overwrite it.',
  },
  ko: { heading: '도구 제안 변경', note: '이 하위 작업은 사람이 수정해 도구가 덮어쓰지 않음.' },
  ja: {
    heading: 'ツールからの変更提案',
    note: 'このサブタスクは手動で編集されているため上書きしていません。',
  },
  'zh-CN': { heading: '工具建议的修改', note: '此子任务已被手动修改,工具未覆盖。' },
};

/** A failed Jira response. Only the names of rejected fields are kept, never the body text. */
export class JiraHttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly fields: string[];
  constructor(status: number, headers: Record<string, string>, fields: string[]) {
    super(`HTTP ${status}`);
    this.name = 'JiraHttpError';
    this.status = status;
    this.headers = headers;
    this.fields = fields;
  }
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: { type: 'doc'; content?: AdfNode[] } | null;
    labels?: string[];
    status?: { name?: string } | null;
    assignee?: { displayName?: string } | null;
    creator?: { accountId?: string } | null;
  };
}

const caseLabel = (caseId: string) => `qtg-${caseId}`;
const priorityLabel = (c: QaCase) => `qa-${c.priority.toLowerCase()}`;

/** Splits a description into tool nodes, the payload expand and the nodes people added after it. */
export function splitDescription(doc: JiraIssue['fields']['description']): {
  tool: AdfNode[];
  payload: string | null;
  caseId: string | null;
  tail: AdfNode[];
} {
  const nodes = Array.isArray(doc?.content) ? doc.content : [];
  const at = nodes.findLastIndex((n) => n.type === 'expand' && payloadText(n) !== null);
  if (at < 0) return { tool: nodes, payload: null, caseId: null, tail: [] };
  const text = payloadText(nodes[at] as AdfNode) ?? '';
  return {
    tool: nodes.slice(0, at),
    caseId: text.match(/^qtg-case:([A-Za-z0-9._-]+)/m)?.[1] ?? null,
    payload: text.match(/^qtg-data:([A-Za-z0-9+/=]+)/m)?.[1] ?? null,
    tail: nodes.slice(at + 1),
  };
}

function payloadText(node: AdfNode): string | null {
  const block = (Array.isArray(node.content) ? node.content : []).find(
    (c): c is AdfNode => typeof c === 'object' && c !== null && (c as AdfNode).type === 'codeBlock',
  );
  const text = (Array.isArray(block?.content) ? block.content : [])
    .map((t) => (typeof (t as AdfNode).text === 'string' ? ((t as AdfNode).text as string) : ''))
    .join('');
  return /^qtg-case:/.test(text) ? text : null;
}

function payloadNode(p: SinkPayload): AdfNode {
  return {
    type: 'expand',
    attrs: { title: PAYLOAD_TITLE },
    content: [
      { type: 'codeBlock', content: [adfText(`qtg-case:${p.caseId}\nqtg-data:${encodePayload(p)}`)] },
    ],
  };
}

const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date']);

/**
 * Structure + plain text of ADF nodes, marks and attrs ignored. Jira may re-split text runs or add
 * attrs (localId…) when it stores a description; that must not look like a person's edit, while
 * changed words or a new list item must.
 */
export function adfPlain(nodes: unknown[], depth = 0): string {
  const lines: string[] = [];
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue;
    const n = raw as AdfNode;
    const kids = (Array.isArray(n.content) ? n.content : []) as AdfNode[];
    const text = kids
      .filter((k) => INLINE.has(String(k.type)))
      .map((k) => (k.type === 'hardBreak' ? '\n' : String(k.text ?? k.attrs?.text ?? k.attrs?.url ?? '')))
      .join('');
    lines.push(`${'  '.repeat(depth)}${String(n.type)}:${text}`);
    const blocks = kids.filter((k) => !INLINE.has(String(k.type)));
    if (blocks.length) lines.push(adfPlain(blocks, depth + 1));
  }
  return lines.join('\n');
}
const clip = (s: string) => (s.length <= SUMMARY_LIMIT ? s : `${s.slice(0, SUMMARY_LIMIT - 1)}…`);

/**
 * Creates the Jira sink. Cases become Sub-tasks (`subtaskType`) of the spec story, labelled
 * `qtg-case` and `qtg-<caseId>`. People own the status, the assignee, comments and other labels.
 */
export function createJiraCaseSink(
  options: JiraCaseSinkOptions | null,
  ctx: SinkContext,
  deps: JiraCaseSinkDeps = {},
): CaseSink {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const base = options?.baseUrl.replace(/\/+$/, '') ?? '';
  const auth = options ? Buffer.from(`${options.email}:${options.apiToken}`).toString('base64') : '';
  let priorityUnsupported = false;
  let account: Promise<string> | undefined;

  async function request<T>(
    method: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
    action = 'calling Jira',
  ): Promise<T> {
    if (!options) throw new QtgError('config_invalid', 'Jira is not configured.');
    try {
      return await withRetry(
        async () => {
          const res = await doFetch(`${base}${path}`, {
            method,
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: 'application/json',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal,
          });
          if (!res.ok) {
            let fields: string[] = [];
            try {
              const j = (await res.json()) as { errors?: Record<string, unknown> };
              fields = Object.keys(j?.errors ?? {});
            } catch {
              // no JSON body
            }
            throw new JiraHttpError(res.status, Object.fromEntries(res.headers), fields);
          }
          const text = res.status === 204 ? '' : await res.text();
          return (text ? JSON.parse(text) : null) as T;
        },
        { maxRetries: 3, ...deps.retry },
        signal,
      );
    } catch (err) {
      if (err instanceof JiraHttpError && err.status === 400) throw err; // callers inspect `fields`
      throw sinkError(err, 'Jira sink', action);
    }
  }

  const me = (signal: AbortSignal): Promise<string> => {
    account ??= request<{ accountId: string }>(
      'GET',
      '/rest/api/3/myself',
      signal,
      undefined,
      'reading the account',
    ).then((r) => r.accountId);
    return account;
  };

  function storyKey(spec: PrdRef): string {
    const key = spec.id.toUpperCase();
    if (spec.source !== 'jira' || !ISSUE_KEY.test(key)) {
      throw new QtgError(
        'config_invalid',
        `The Jira sink adds cases as sub-tasks of a Jira story, but the spec ${spec.id} is not a Jira issue. Remove "jira" from sinks for this spec.`,
      );
    }
    return key;
  }

  const getIssue = (key: string, signal: AbortSignal) =>
    request<JiraIssue>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`,
      signal,
      undefined,
      'reading a sub-task',
    );

  const payloadFor = (c: QaCase, r: RenderedCase, title: string, tool: AdfNode[]): SinkPayload => ({
    v: 1,
    caseId: c.caseId,
    hash: r.hash,
    digest: areaDigest(title, adfPlain(tool)),
    case: c,
  });

  const labelOps = (current: string[], wanted: string[], removable: (l: string) => boolean) => [
    ...wanted.filter((l) => !current.includes(l)).map((add) => ({ add })),
    ...current.filter((l) => removable(l) && !wanted.includes(l)).map((remove) => ({ remove })),
  ];
  const toolOwned = (l: string) => /^qa-p[0-2]$/.test(l) || l === OBSOLETE_TICKET_LABEL;

  async function upsertComment(
    key: string,
    marker: string,
    body: { type: 'doc'; version: 1; content: AdfNode[] },
    signal: AbortSignal,
  ) {
    const mine = await me(signal);
    let found: { id: string; body: unknown } | undefined;
    for (let startAt = 0; ; ) {
      const page = await request<{
        comments: { id: string; author?: { accountId?: string }; body: unknown }[];
        total: number;
      }>(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
        signal,
        undefined,
        'listing comments',
      );
      for (const c of page.comments) {
        if (c.author?.accountId === mine && adfToMarkdown(c.body).includes(marker)) found = c;
      }
      startAt += page.comments.length;
      if (page.comments.length === 0 || startAt >= page.total) break;
    }
    if (found && adfToMarkdown(found.body) === adfToMarkdown(body)) return found.id;
    if (found) {
      await request(
        'PUT',
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment/${found.id}`,
        signal,
        { body },
        'updating a comment',
      );
      return found.id;
    }
    const created = await request<{ id: string }>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      signal,
      { body },
      'adding a comment',
    );
    return created.id;
  }

  return {
    kind: 'jira',
    isConfigured: () => options !== null,

    async list(spec, signal) {
      const key = storyKey(spec);
      const mine = await me(signal);
      const jql = `parent = "${key}" AND labels = "${CASE_LABEL}" ORDER BY created ASC`;
      const tickets: ExistingCaseTicket[] = [];
      let foreign = 0;
      let nextPageToken: string | undefined;
      do {
        const page = await request<{ issues: JiraIssue[]; nextPageToken?: string }>(
          'POST',
          '/rest/api/3/search/jql',
          signal,
          { jql, fields: FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
          'searching sub-tasks',
        );
        for (const issue of page.issues) {
          if (issue.fields.creator?.accountId !== mine) {
            foreign++;
            continue;
          }
          const parts = splitDescription(issue.fields.description);
          const fromLabel = (issue.fields.labels ?? [])
            .find((l) => l.startsWith('qtg-') && l !== CASE_LABEL && l !== OBSOLETE_TICKET_LABEL)
            ?.slice(4);
          const caseId = parts.caseId ?? fromLabel;
          if (!caseId) continue;
          tickets.push(
            ticketFrom({
              caseId,
              ticketRef: issue.key,
              url: `${base}/browse/${issue.key}`,
              payload: decodePayload(parts.payload, caseId),
              now: areaDigest(issue.fields.summary ?? '', adfPlain(parts.tool)),
              human: {
                ...(issue.fields.status?.name ? { execStatus: issue.fields.status.name } : {}),
                ...(issue.fields.assignee?.displayName
                  ? { assignee: issue.fields.assignee.displayName }
                  : {}),
              },
            }),
          );
        }
        nextPageToken = page.nextPageToken;
      } while (nextPageToken);
      if (foreign)
        ctx.logger.warn(
          `Jira: ignored ${foreign} sub-task(s) labelled qtg-case but not created by the tool's account.`,
        );
      return tickets;
    },

    async create(spec, c, r, signal) {
      const key = storyKey(spec);
      const summary = clip(r.title);
      const tool = markdownToAdf(r.markdown).content;
      const description = {
        type: 'doc',
        version: 1,
        content: [...tool, payloadNode(payloadFor(c, r, summary, tool))],
      };
      const fields = (withPriority: boolean) => ({
        project: { key: key.split('-')[0] },
        parent: { key },
        issuetype: { name: options?.subtaskType ?? 'Sub-task' },
        summary,
        description,
        labels: [CASE_LABEL, caseLabel(c.caseId), ...(withPriority ? [] : [priorityLabel(c)])],
        ...(withPriority ? { priority: { name: PRIORITY_NAME[c.priority] } } : {}),
      });
      let created: { key: string };
      try {
        created = await request<{ key: string }>(
          'POST',
          '/rest/api/3/issue',
          signal,
          { fields: fields(!priorityUnsupported) },
          'creating a sub-task',
        );
      } catch (err) {
        if (!(err instanceof JiraHttpError && err.fields.includes('priority')) || priorityUnsupported) {
          throw err instanceof JiraHttpError
            ? sinkError(
                err,
                'Jira sink',
                `creating a sub-task (rejected fields: ${err.fields.join(', ') || 'none named'})`,
              )
            : err;
        }
        // The sub-task screen has no priority field: fall back to a qa-pN label from now on.
        priorityUnsupported = true;
        ctx.logger.warn(
          'Jira: the sub-task screen does not accept a priority; using qa-p0/p1/p2 labels instead.',
        );
        created = await request<{ key: string }>(
          'POST',
          '/rest/api/3/issue',
          signal,
          { fields: fields(false) },
          'creating a sub-task',
        );
      }
      return { ticketRef: created.key, url: `${base}/browse/${created.key}` };
    },

    async update(t, c, r, signal) {
      const issue = await getIssue(t.ticketRef, signal);
      const { tail } = splitDescription(issue.fields.description);
      const summary = clip(r.title);
      const tool = markdownToAdf(r.markdown).content;
      const description = {
        type: 'doc',
        version: 1,
        content: [...tool, payloadNode(payloadFor(c, r, summary, tool)), ...tail],
      };
      const wanted = [CASE_LABEL, caseLabel(c.caseId), ...(priorityUnsupported ? [priorityLabel(c)] : [])];
      const labels = labelOps(issue.fields.labels ?? [], wanted, toolOwned);
      // Summary, description, priority and the tool's labels only — never status or assignee.
      await request(
        'PUT',
        `/rest/api/3/issue/${encodeURIComponent(t.ticketRef)}`,
        signal,
        {
          fields: {
            summary,
            description,
            ...(priorityUnsupported ? {} : { priority: { name: PRIORITY_NAME[c.priority] } }),
          },
          ...(labels.length ? { update: { labels } } : {}),
        },
        'updating a sub-task',
      ).catch(async (err: unknown) => {
        if (!(err instanceof JiraHttpError && err.fields.includes('priority'))) throw err;
        priorityUnsupported = true;
        await request(
          'PUT',
          `/rest/api/3/issue/${encodeURIComponent(t.ticketRef)}`,
          signal,
          {
            fields: { summary, description },
            update: { labels: labelOps(issue.fields.labels ?? [], [...wanted, priorityLabel(c)], toolOwned) },
          },
          'updating a sub-task',
        );
      });
    },

    async suggest(t, c, r, signal) {
      const text = PROPOSED[ctx.language];
      const marker = `${suggestMarker(c.caseId)} ${r.hash}`;
      const body = {
        type: 'doc' as const,
        version: 1 as const,
        content: [
          { type: 'paragraph', content: [adfText(text.heading, [{ type: 'strong' }])] },
          { type: 'paragraph', content: [adfText(text.note)] },
          { type: 'paragraph', content: [adfText(clip(r.title), [{ type: 'strong' }])] },
          ...markdownToAdf(r.markdown).content,
          { type: 'paragraph', content: [adfText(marker, [{ type: 'code' }])] },
        ],
      };
      await upsertComment(t.ticketRef, suggestMarker(c.caseId), body, signal);
    },

    async markObsolete(t, signal) {
      const issue = await getIssue(t.ticketRef, signal);
      const summary = clip(obsoleteTitle(issue.fields.summary ?? '', ctx.language));
      const parts = splitDescription(issue.fields.description);
      const old = decodePayload(parts.payload, t.caseId);
      const fields: Record<string, unknown> = { summary };
      if (old) {
        const payload: SinkPayload = {
          ...old,
          case: { ...old.case, lifecycle: 'obsolete' },
          digest: { ...old.digest, title: areaDigest(summary, '').title },
        };
        fields.description = {
          type: 'doc',
          version: 1,
          content: [...parts.tool, payloadNode(payload), ...parts.tail],
        };
      }
      const labels = labelOps(
        issue.fields.labels ?? [],
        [...(issue.fields.labels ?? []), OBSOLETE_TICKET_LABEL],
        () => false,
      );
      await request(
        'PUT',
        `/rest/api/3/issue/${encodeURIComponent(t.ticketRef)}`,
        signal,
        { fields, ...(labels.length ? { update: { labels } } : {}) },
        'marking a sub-task obsolete',
      );
    },

    async publishSummary(spec, summary: CaseSetSummary, signal) {
      if (spec.source !== 'jira') return {};
      const key = storyKey(spec);
      const { heading, counts, lines, empty } = summaryLines(summary, (url) => url);
      const marker = summaryMarker(key);
      const items: AdfNode[] = lines.map((l) => {
        const strike = l.obsolete ? [{ type: 'strike' }] : [];
        const issueKey = l.ref?.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/)?.[1];
        const head = issueKey
          ? [adfText(issueKey, [...strike, { type: 'link', attrs: { href: l.ref } }]), adfText(' ', strike)]
          : [];
        return {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [...head, adfText(l.text, strike)] }],
        };
      });
      const body = {
        type: 'doc' as const,
        version: 1 as const,
        content: [
          { type: 'heading', attrs: { level: 3 }, content: [adfText(heading)] },
          { type: 'paragraph', content: [adfText(counts)] },
          ...(items.length
            ? [{ type: 'bulletList', content: items }]
            : [{ type: 'paragraph', content: [adfText(empty)] }]),
          { type: 'paragraph', content: [adfText(marker, [{ type: 'code' }])] },
        ],
      };
      const id = await upsertComment(key, marker, body, signal);
      return { url: `${base}/browse/${key}?focusedCommentId=${id}` };
    },
  };
}
