/**
 * Notion case sink: one row per case in the QA case database (SPEC v3 §4, §5).
 * Owner: qa-work-session-a.
 *
 * Row layout:
 * - properties the tool owns: the title, `Case ID`, `Spec`, `AC`, `Technique`, `Priority`,
 *   `Code status`, `Lifecycle` and `QTG data` (the hidden payload; hide the column in views);
 * - properties people own, read but never written: `실행 결과`, `담당자`;
 * - page body: one quote block tagged with the case id holds the case text. Blocks people add
 *   anywhere else on the page are left alone; an update swaps only that container.
 */
import { Client } from '@notionhq/client';
import type { CaseSink, ExistingCaseTicket, QaCase, RenderedCase, SinkContext } from '../core/cases';
import type { Language, PrdRef } from '../core/contracts';
import { QtgError } from '../core/errors';
import {
  areaDigest,
  decodePayload,
  encodePayload,
  obsoleteTitle,
  type SinkPayload,
  sameTextUpdate,
  sinkError,
  suggestMarker,
  ticketFrom,
} from './common';
import { parseMarkdown } from './md-parse';
import {
  markdownToNotion,
  type NotionBlock,
  type NotionRichText,
  plainRichText,
  richText,
} from './md-to-notion';

export interface NotionCaseSinkOptions {
  token: string;
  databaseId: string;
}

export interface NotionCaseSinkDeps {
  /** Replaces the HTTP layer of the Notion client (tests). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export const PROP = {
  caseId: 'Case ID',
  spec: 'Spec',
  ac: 'AC',
  technique: 'Technique',
  priority: 'Priority',
  codeStatus: 'Code status',
  lifecycle: 'Lifecycle',
  exec: '실행 결과',
  assignee: '담당자',
  data: 'QTG data',
} as const;

type PropType = 'rich_text' | 'select';
/** Properties the sink needs; added on first use when missing (SPEC v3 Q1). */
const REQUIRED: [string, PropType][] = [
  [PROP.caseId, 'rich_text'],
  [PROP.spec, 'rich_text'],
  [PROP.ac, 'rich_text'],
  [PROP.technique, 'select'],
  [PROP.priority, 'select'],
  [PROP.codeStatus, 'select'],
  [PROP.lifecycle, 'select'],
  [PROP.exec, 'select'],
  [PROP.data, 'rich_text'],
];
const WRITABLE = new Set(['title', 'rich_text', 'select', 'multi_select']);

const LIFECYCLE: Record<Language, Record<QaCase['lifecycle'], string>> = {
  en: { active: 'Active', obsolete: 'Obsolete' },
  ko: { active: '활성', obsolete: '해당 없음' },
  ja: { active: '有効', obsolete: '対象外' },
  'zh-CN': { active: '有效', obsolete: '不再适用' },
};
const CODE_STATUS: Record<Language, Record<NonNullable<QaCase['codeStatus']>['status'], string>> = {
  en: {
    implemented: 'Implemented',
    missing: 'Missing',
    contradicts: 'Contradicts spec',
    unknown: 'Cannot tell',
  },
  ko: {
    implemented: '구현 확인됨',
    missing: '미구현 의심',
    contradicts: '기획과 상충',
    unknown: '코드로 판단 불가',
  },
  ja: {
    implemented: '実装確認済み',
    missing: '未実装の疑い',
    contradicts: '仕様と矛盾',
    unknown: 'コードから判断不可',
  },
  'zh-CN': {
    implemented: '已实现',
    missing: '疑似未实现',
    contradicts: '与需求冲突',
    unknown: '无法从代码判断',
  },
};
const EXEC_OPTIONS: Record<Language, string[]> = {
  en: ['Not run', 'Pass', 'Fail', 'Blocked'],
  ko: ['미실행', 'Pass', 'Fail', 'Blocked'],
  ja: ['未実施', 'Pass', 'Fail', 'Blocked'],
  'zh-CN': ['未执行', 'Pass', 'Fail', 'Blocked'],
};
const PROPOSED: Record<Language, { heading: string; note: string }> = {
  en: {
    heading: 'Tool-proposed change',
    note: 'This row was edited by hand, so the tool did not overwrite it. Proposed version:',
  },
  ko: { heading: '도구 제안 변경', note: '이 행은 사람이 수정해 도구가 덮어쓰지 않음. 제안 내용:' },
  ja: {
    heading: 'ツールからの変更提案',
    note: 'この行は手動で編集されているため上書きしていません。提案内容:',
  },
  'zh-CN': { heading: '工具建议的修改', note: '此行已被手动修改,工具未覆盖。建议内容:' },
};

interface NotionPage {
  object: string;
  id: string;
  url?: string;
  created_by?: { id?: string };
  properties: Record<string, NotionProp>;
}
interface NotionProp {
  type?: string;
  title?: { plain_text?: string }[];
  rich_text?: { plain_text?: string }[];
  select?: { name?: string } | null;
  multi_select?: { name?: string }[];
  people?: { name?: string }[];
}
interface NotionBlockResponse {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

const rtPlain = (items: unknown): string =>
  (Array.isArray(items) ? items : [])
    .map((i: { plain_text?: string; text?: { content?: string } }) => i?.plain_text ?? i?.text?.content ?? '')
    .join('');

function propText(p: NotionProp | undefined): string {
  if (!p) return '';
  if (p.type === 'title') return rtPlain(p.title);
  if (p.type === 'rich_text') return rtPlain(p.rich_text);
  if (p.type === 'select') return p.select?.name ?? '';
  if (p.type === 'multi_select') return (p.multi_select ?? []).map((o) => o.name).join(', ');
  return '';
}

/**
 * Structure + plain text of blocks (requests or responses), annotations ignored: Notion may split
 * or merge text runs when it stores them, which must not look like a person's edit.
 */
export function notionPlain(blocks: (NotionBlock | NotionBlockResponse)[], depth = 0): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const body = (b as Record<string, unknown>)[b.type] as Record<string, unknown> | undefined;
    const text =
      b.type === 'table_row'
        ? ((body?.cells as unknown[][] | undefined) ?? []).map(rtPlain).join(' | ')
        : rtPlain(body?.rich_text);
    lines.push(`${'  '.repeat(depth)}${b.type}:${text}`);
    const kids = body?.children as NotionBlock[] | undefined;
    if (Array.isArray(kids) && kids.length) lines.push(notionPlain(kids, depth + 1));
  }
  return lines.join('\n');
}

/** Markdown → comment rich text (comments hold rich text only): one line per block. */
function commentRichText(markdown: string): NotionRichText[] {
  const out: NotionRichText[] = [];
  const line = (prefix: string, rt: NotionRichText[]) => {
    if (out.length) out.push(...plainRichText('\n'));
    if (prefix) out.push(...plainRichText(prefix));
    out.push(...rt);
  };
  for (const b of parseMarkdown(markdown)) {
    if (b.type === 'heading' || b.type === 'paragraph') line('', richText(b.inline));
    else if (b.type === 'list') {
      b.items.forEach((it, i) => {
        const first = it.blocks[0];
        const rt =
          first && (first.type === 'paragraph' || first.type === 'heading') ? richText(first.inline) : [];
        line(b.ordered ? `${b.start + i}. ` : '- ', rt);
      });
    } else if (b.type === 'code') line('', plainRichText(b.text));
  }
  return out;
}

const containerFor = (caseId: string, content: NotionBlock[]): NotionBlock => ({
  object: 'block',
  type: 'quote',
  quote: {
    rich_text: richText([{ type: 'text', text: caseId, marks: ['code'] }]),
    children: content.slice(0, 100),
  },
});

/**
 * Creates the Notion sink for the case database `databaseId`. `null` options → not configured.
 */
export function createNotionCaseSink(
  options: NotionCaseSinkOptions | null,
  ctx: SinkContext,
  deps: NotionCaseSinkDeps = {},
): CaseSink {
  const baseFetch = deps.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));

  /** One client per call so the run's AbortSignal reaches the HTTP layer (the SDK takes none). */
  const api = <T>(
    signal: AbortSignal,
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
    action = 'calling Notion',
  ): Promise<T> => {
    if (!options) return Promise.reject(new QtgError('config_invalid', 'Notion is not configured.'));
    const client = new Client({
      auth: options.token,
      fetch: (url, init) => baseFetch(url, { ...(init as RequestInit), signal }),
      logger: () => undefined, // its warnings can include response bodies (OBS-01)
      retry: { maxRetries: 2, initialRetryDelayMs: 500, maxRetryDelayMs: 5_000 },
    });
    return client
      .request<T & object>({ path, method, ...(body ? { body } : {}), ...(query ? { query } : {}) })
      .catch((err: unknown) => {
        if (signal.aborted) throw signal.reason;
        throw sinkError(err, 'Notion sink', action);
      }) as Promise<T>;
  };

  async function paginate<T>(
    signal: AbortSignal,
    method: 'get' | 'post',
    path: string,
    body: Record<string, unknown>,
    action: string,
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await api<{ results: T[]; has_more: boolean; next_cursor: string | null }>(
        signal,
        method,
        path,
        method === 'post'
          ? { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }
          : undefined,
        method === 'get' ? { page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) } : undefined,
        action,
      );
      all.push(...page.results);
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
    return all;
  }

  let schema: Promise<{ dataSourceId: string; titleProp: string; types: Map<string, string> }> | undefined;
  const ensureSchema = (signal: AbortSignal) => {
    schema ??= (async () => {
      const db = await api<{ data_sources?: { id: string }[] }>(
        signal,
        'get',
        `databases/${options?.databaseId}`,
        undefined,
        undefined,
        'reading the QA case database',
      );
      const dataSourceId = db.data_sources?.[0]?.id;
      if (!dataSourceId)
        throw new QtgError(
          'config_invalid',
          'Notion: the QA case database has no data source. Check notion-qa-database-id.',
        );
      const ds = await api<{ properties: Record<string, { type: string }> }>(
        signal,
        'get',
        `data_sources/${dataSourceId}`,
        undefined,
        undefined,
        'reading the database schema',
      );
      const types = new Map(Object.entries(ds.properties).map(([name, p]) => [name, p.type]));
      const missing = REQUIRED.filter(([name]) => !types.has(name));
      if (missing.length) {
        const properties = Object.fromEntries(
          missing.map(([name, type]) => [
            name,
            type === 'select' && name === PROP.exec
              ? { select: { options: EXEC_OPTIONS[ctx.language].map((o) => ({ name: o })) } }
              : { [type]: {} },
          ]),
        );
        try {
          await api(
            signal,
            'patch',
            `data_sources/${dataSourceId}`,
            { properties },
            undefined,
            'adding database properties',
          );
          for (const [name, type] of missing) types.set(name, type);
          ctx.logger.info(`Notion: added ${missing.length} propert(ies) to the QA case database.`);
        } catch (err) {
          throw new QtgError(
            'config_invalid',
            `Notion: the QA case database is missing ${missing.map(([n, t]) => `"${n}" (${t})`).join(', ')} and the integration could not add them. Add them by hand or give the integration edit access.`,
            { cause: err },
          );
        }
      }
      const titleProp = [...types].find(([, t]) => t === 'title')?.[0] ?? 'Name';
      for (const [name] of REQUIRED) {
        const t = types.get(name);
        if (t && !WRITABLE.has(t) && name !== PROP.exec)
          ctx.logger.warn(`Notion: property "${name}" has type ${t}; the sink leaves it empty.`);
      }
      return { dataSourceId, titleProp, types };
    })().catch((err: unknown) => {
      schema = undefined;
      throw err;
    });
    return schema;
  };

  let botId: Promise<string> | undefined;
  const me = (signal: AbortSignal) => {
    botId ??= api<{ id: string }>(
      signal,
      'get',
      'users/me',
      undefined,
      undefined,
      'reading the integration user',
    ).then((u) => u.id);
    return botId;
  };

  /** Property value in whatever type the database uses for that column. */
  function valueFor(type: string | undefined, value: string | null): Record<string, unknown> | null {
    switch (type) {
      case 'title':
        return { title: plainRichText(value ?? '') };
      case 'rich_text':
        return { rich_text: value ? plainRichText(value) : [] };
      case 'select':
        return { select: value ? { name: value.replace(/,/g, ' ').slice(0, 100) } : null };
      case 'multi_select':
        return { multi_select: value ? [{ name: value.replace(/,/g, ' ').slice(0, 100) }] : [] };
      default:
        return null;
    }
  }

  function caseProps(
    s: { titleProp: string; types: Map<string, string> },
    c: QaCase,
    r: RenderedCase,
    title: string,
    payload: SinkPayload,
  ): Record<string, unknown> {
    const code = c.codeStatus
      ? (r.fields.code_status_label ?? CODE_STATUS[ctx.language][c.codeStatus.status])
      : null;
    const values: [string, string | null][] = [
      [s.titleProp, title],
      [PROP.caseId, c.caseId],
      [PROP.spec, c.specRef],
      [PROP.ac, r.fields.ac ?? c.acLabels.join(', ')],
      [PROP.technique, r.fields.technique_label ?? c.technique],
      [PROP.priority, c.priority],
      [PROP.codeStatus, code],
      [PROP.lifecycle, LIFECYCLE[ctx.language][c.lifecycle]],
      [PROP.data, encodePayload(payload)],
    ];
    const props: Record<string, unknown> = {};
    for (const [name, value] of values) {
      const v = valueFor(name === s.titleProp ? 'title' : s.types.get(name), value);
      if (v) props[name] = v;
    }
    return props;
  }

  /** The case container: the quote block tagged with the case id (people may add blocks around it). */
  async function findContainer(pageId: string, caseId: string, signal: AbortSignal) {
    const blocks = await paginate<NotionBlockResponse>(
      signal,
      'get',
      `blocks/${pageId}/children`,
      {},
      'reading a case page',
    );
    const container = blocks.find(
      (b) => b.type === 'quote' && rtPlain((b.quote as { rich_text?: unknown })?.rich_text).trim() === caseId,
    );
    if (!container) return null;
    const children = await paginate<NotionBlockResponse>(
      signal,
      'get',
      `blocks/${container.id}/children`,
      {},
      'reading a case body',
    );
    return { id: container.id, children };
  }

  const titleOf = (r: RenderedCase) => r.fields.name ?? r.title;
  const payloadFor = (c: QaCase, r: RenderedCase, title: string, content: NotionBlock[]): SinkPayload => ({
    v: 1,
    caseId: c.caseId,
    hash: r.hash,
    digest: areaDigest(title, notionPlain(content.slice(0, 100))),
    case: c,
  });

  return {
    kind: 'notion',
    isConfigured: () => Boolean(options?.token && options.databaseId),

    async list(spec: PrdRef, signal) {
      const s = await ensureSchema(signal);
      const bot = await me(signal);
      const specType = s.types.get(PROP.spec) === 'select' ? 'select' : 'rich_text';
      const pages = await paginate<NotionPage>(
        signal,
        'post',
        `data_sources/${s.dataSourceId}/query`,
        {
          filter: { property: PROP.spec, [specType]: { equals: spec.id } },
          sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
        },
        'querying case rows',
      );
      const tickets: ExistingCaseTicket[] = [];
      let foreign = 0;
      for (const page of pages) {
        if (page.object !== 'page') continue;
        if (page.created_by?.id !== bot) {
          foreign++;
          continue;
        }
        const caseId = propText(page.properties[PROP.caseId]).trim();
        if (!caseId) continue;
        const container = await findContainer(page.id, caseId, signal);
        const exec = propText(page.properties[PROP.exec]);
        const assignee = page.properties[PROP.assignee]?.people?.[0]?.name;
        tickets.push(
          ticketFrom({
            caseId,
            ticketRef: page.id,
            url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`,
            payload: decodePayload(propText(page.properties[PROP.data]), caseId),
            now: areaDigest(
              propText(page.properties[s.titleProp]),
              container ? notionPlain(container.children) : '',
            ),
            human: { ...(exec ? { execStatus: exec } : {}), ...(assignee ? { assignee } : {}) },
          }),
        );
      }
      if (foreign)
        ctx.logger.warn(`Notion: ignored ${foreign} row(s) for this spec not created by the integration.`);
      return tickets;
    },

    async create(_spec, c, r, signal) {
      const s = await ensureSchema(signal);
      const content = markdownToNotion(r.markdown, 1);
      const title = titleOf(r);
      const page = await api<{ id: string; url?: string }>(
        signal,
        'post',
        'pages',
        {
          parent: { type: 'data_source_id', data_source_id: s.dataSourceId },
          properties: caseProps(s, c, r, title, payloadFor(c, r, title, content)),
          children: [containerFor(c.caseId, content)],
        },
        undefined,
        'creating a case row',
      );
      if (content.length > 100)
        ctx.logger.warn(`Notion: case ${c.caseId} has more than 100 blocks; the rest was not written.`);
      return { ticketRef: page.id, url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}` };
    },

    async update(t, c, r, signal) {
      const s = await ensureSchema(signal);
      const content = markdownToNotion(r.markdown, 1);
      const title = titleOf(r);
      // Tool-owned properties only; 실행 결과 and 담당자 are never sent.
      await api(
        signal,
        'patch',
        `pages/${t.ticketRef}`,
        { properties: caseProps(s, c, r, title, payloadFor(c, r, title, content)) },
        undefined,
        'updating a case row',
      );
      // Same text as written (only tool fields like specDigest moved): the properties above carry
      // the new record; the page body stays as it is (saves three or four calls per row).
      if (sameTextUpdate(t, r)) return;
      const old = await findContainer(t.ticketRef, c.caseId, signal);
      await api(
        signal,
        'patch',
        `blocks/${t.ticketRef}/children`,
        {
          children: [containerFor(c.caseId, content)],
          position: old ? { type: 'after_block', after_block: { id: old.id } } : { type: 'start' },
        },
        undefined,
        'writing a case body',
      );
      if (old)
        await api(signal, 'delete', `blocks/${old.id}`, undefined, undefined, 'removing the old case body');
    },

    async suggest(t, c, r, signal) {
      const bot = await me(signal);
      const text = PROPOSED[ctx.language];
      const marker = `${suggestMarker(c.caseId)} ${r.hash}`;
      const rich = [
        ...richText([{ type: 'text', text: text.heading, marks: ['strong'] }]),
        ...plainRichText(`\n${text.note}\n\n`),
        ...richText([{ type: 'text', text: titleOf(r), marks: ['strong'] }]),
        ...plainRichText('\n'),
        ...commentRichText(r.markdown),
        ...plainRichText('\n\n'),
        ...richText([{ type: 'text', text: marker, marks: ['code'] }]),
      ];
      const comments = await paginate<{ id: string; created_by?: { id?: string }; rich_text?: unknown }>(
        signal,
        'get',
        `comments?block_id=${t.ticketRef}`,
        {},
        'listing comments',
      );
      const existing = comments
        .filter((cm) => cm.created_by?.id === bot && rtPlain(cm.rich_text).includes(suggestMarker(c.caseId)))
        .at(-1);
      if (existing && rtPlain(existing.rich_text) === rtPlain(rich)) return;
      if (existing)
        await api(
          signal,
          'patch',
          `comments/${existing.id}`,
          { rich_text: rich },
          undefined,
          'updating a comment',
        );
      else
        await api(
          signal,
          'post',
          'comments',
          { parent: { page_id: t.ticketRef }, rich_text: rich },
          undefined,
          'adding a comment',
        );
    },

    async markObsolete(t, signal) {
      const s = await ensureSchema(signal);
      const page = await api<NotionPage>(
        signal,
        'get',
        `pages/${t.ticketRef}`,
        undefined,
        undefined,
        'reading a case row',
      );
      const title = obsoleteTitle(propText(page.properties[s.titleProp]), ctx.language);
      const old = decodePayload(propText(page.properties[PROP.data]), t.caseId);
      const properties: Record<string, unknown> = {
        [s.titleProp]: valueFor('title', title),
      };
      const lifecycle = valueFor(s.types.get(PROP.lifecycle), LIFECYCLE[ctx.language].obsolete);
      if (lifecycle) properties[PROP.lifecycle] = lifecycle;
      if (old) {
        const payload: SinkPayload = {
          ...old,
          case: { ...old.case, lifecycle: 'obsolete' },
          digest: { ...old.digest, title: areaDigest(title, '').title },
        };
        const data = valueFor(s.types.get(PROP.data), encodePayload(payload));
        if (data) properties[PROP.data] = data;
      }
      await api(
        signal,
        'patch',
        `pages/${t.ticketRef}`,
        { properties },
        undefined,
        'marking a case obsolete',
      );
    },

    async publishSummary() {
      // The case database is shared by every spec, so there is no per-spec place to update in
      // Notion; the spec-side summary comes from the GitHub / Jira sinks and the job summary.
      return {};
    },
  };
}
