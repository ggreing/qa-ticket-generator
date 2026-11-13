import { describe, expect, it } from 'vitest';
import { QtgError } from '../../src/core/errors';
import { createNotionCaseSink, notionPlain, PROP } from '../../src/sinks/notion';
import { fakeFetch, json, type RecordedRequest } from '../context/helpers';
import { baseCase, githubSpec, jiraSpec, render, signal, sinkCtx } from './support';

type Json = Record<string, unknown>;
interface StoredBlock {
  object: 'block';
  id: string;
  type: string;
  has_children: boolean;
  [k: string]: unknown;
}

/** Stores rich text like Notion: plain_text/href added, long runs split in two. */
function storeRich(items: unknown): Json[] {
  return ((items as Json[]) ?? []).flatMap((i) => {
    const text = (i.text as { content: string; link: { url: string } | null }) ?? { content: '', link: null };
    const make = (content: string) => ({
      type: 'text',
      text: { content, link: text.link },
      plain_text: content,
      href: text.link?.url ?? null,
      annotations: i.annotations ?? {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
    });
    if (text.content.length > 6) {
      const mid = Math.floor(text.content.length / 2);
      return [make(text.content.slice(0, mid)), make(text.content.slice(mid))];
    }
    return [make(text.content)];
  });
}

class FakeNotion {
  props = new Map<string, string>([['Name', 'title']]);
  pages = new Map<string, Json>();
  order: string[] = [];
  blocks = new Map<string, StoredBlock>();
  children = new Map<string, string[]>();
  comments: { id: string; parent: string; created_by: { id: string }; rich_text: Json[] }[] = [];
  writes: { method: string; path: string; body: Json }[] = [];
  bot = 'bot-1';
  actor = 'bot-1';
  failSchema = false;
  private seq = 1;

  id = (p: string) => `${p}-${String(this.seq++).padStart(4, '0')}`;

  handle = (req: RecordedRequest): Response => {
    const path = req.url.pathname.replace(/^\/v1\//, '');
    const body = req.body ? (JSON.parse(req.body) as Json) : {};
    if (req.method !== 'GET') this.writes.push({ method: req.method, path, body });
    if (path === 'databases/db1')
      return json({ object: 'database', id: 'db1', data_sources: [{ id: 'ds1', name: 'QA' }] });
    if (path === 'data_sources/ds1' && req.method === 'GET') {
      return json({
        object: 'data_source',
        id: 'ds1',
        properties: Object.fromEntries([...this.props].map(([n, t]) => [n, { id: n, type: t }])),
      });
    }
    if (path === 'data_sources/ds1' && req.method === 'PATCH') {
      if (this.failSchema)
        return json({ object: 'error', status: 403, code: 'restricted_resource', message: 'x' }, 403);
      for (const [name, def] of Object.entries(body.properties as Json))
        this.props.set(name, Object.keys(def as Json)[0] as string);
      return json({ object: 'data_source', id: 'ds1' });
    }
    if (path === 'users/me') return json({ object: 'user', id: this.bot, type: 'bot' });
    if (path === 'data_sources/ds1/query') {
      const filter = body.filter as { property: string; rich_text?: { equals: string } };
      const all = this.order
        .map((id) => this.pages.get(id) as Json)
        .filter((p) => {
          const spec = (p.properties as Json)[filter.property] as
            | { rich_text?: { plain_text: string }[] }
            | undefined;
          return (spec?.rich_text ?? []).map((t) => t.plain_text).join('') === filter.rich_text?.equals;
        });
      const start = Number(body.start_cursor ?? 0);
      const size = Number(body.page_size ?? 100);
      const more = start + size < all.length;
      return json({
        object: 'list',
        results: all.slice(start, start + size),
        has_more: more,
        next_cursor: more ? String(start + size) : null,
      });
    }
    if (path === 'pages' && req.method === 'POST') {
      const id = this.id('page');
      const page = {
        object: 'page',
        id,
        url: `https://www.notion.so/${id}`,
        created_by: { id: this.actor },
        properties: this.storeProps(body.properties as Json),
      };
      this.pages.set(id, page);
      this.order.push(id);
      this.children.set(id, []);
      this.append(id, (body.children as Json[]) ?? [], undefined);
      return json(page);
    }
    const page = path.match(/^pages\/(.+)$/);
    if (page?.[1]) {
      const p = this.pages.get(page[1]);
      if (!p) return json({ object: 'error', status: 404, code: 'object_not_found' }, 404);
      if (req.method === 'PATCH')
        Object.assign(p.properties as Json, this.storeProps(body.properties as Json));
      return json(p);
    }
    const kids = path.match(/^blocks\/(.+)\/children$/);
    if (kids?.[1]) {
      if (req.method === 'PATCH') {
        const position = body.position as { type: string; after_block?: { id: string } } | undefined;
        this.append(kids[1], body.children as Json[], position);
        return json({ object: 'list', results: [] });
      }
      const ids = this.children.get(kids[1]) ?? [];
      const start = Number(req.url.searchParams.get('start_cursor') ?? 0);
      const size = Number(req.url.searchParams.get('page_size') ?? 100);
      const more = start + size < ids.length;
      return json({
        object: 'list',
        results: ids.slice(start, start + size).map((i) => this.blocks.get(i)),
        has_more: more,
        next_cursor: more ? String(start + size) : null,
      });
    }
    const del = path.match(/^blocks\/(.+)$/);
    if (del?.[1] && req.method === 'DELETE') {
      for (const [parent, ids] of this.children)
        this.children.set(
          parent,
          ids.filter((i) => i !== del[1]),
        );
      this.blocks.delete(del[1]);
      return json({ object: 'block', id: del[1], in_trash: true });
    }
    if (path === 'comments' && req.method === 'GET') {
      const parent = req.url.searchParams.get('block_id');
      return json({
        object: 'list',
        results: this.comments.filter((c) => c.parent === parent),
        has_more: false,
        next_cursor: null,
      });
    }
    if (path === 'comments' && req.method === 'POST') {
      const c = {
        id: this.id('comment'),
        parent: (body.parent as { page_id: string }).page_id,
        created_by: { id: this.actor },
        rich_text: storeRich(body.rich_text),
      };
      this.comments.push(c);
      return json(c);
    }
    const comment = path.match(/^comments\/(.+)$/);
    if (comment?.[1] && req.method === 'PATCH') {
      const c = this.comments.find((x) => x.id === comment[1]);
      if (c) c.rich_text = storeRich(body.rich_text);
      return json(c);
    }
    return json(
      {
        object: 'error',
        status: 400,
        code: 'invalid_request_url',
        message: `unhandled ${req.method} ${path}`,
      },
      400,
    );
  };

  private storeProps(props: Json): Json {
    const out: Json = {};
    for (const [name, v] of Object.entries(props ?? {})) {
      const val = v as Json;
      if ('title' in val) out[name] = { type: 'title', title: storeRich(val.title) };
      else if ('rich_text' in val) out[name] = { type: 'rich_text', rich_text: storeRich(val.rich_text) };
      else if ('select' in val) out[name] = { type: 'select', select: val.select };
      else if ('multi_select' in val) out[name] = { type: 'multi_select', multi_select: val.multi_select };
      else if ('people' in val) out[name] = { type: 'people', people: val.people };
    }
    return out;
  }

  append(parent: string, reqs: Json[], position: { type: string; after_block?: { id: string } } | undefined) {
    const ids = this.children.get(parent) ?? [];
    let at =
      position?.type === 'start'
        ? 0
        : position?.type === 'after_block'
          ? ids.indexOf(position.after_block?.id ?? '') + 1
          : ids.length;
    for (const r of reqs) {
      const id = this.id('block');
      const type = String(r.type);
      const payload = { ...(r[type] as Json) };
      const nested = (payload.children as Json[]) ?? [];
      delete payload.children;
      if (payload.rich_text) payload.rich_text = storeRich(payload.rich_text);
      this.blocks.set(id, { object: 'block', id, type, has_children: nested.length > 0, [type]: payload });
      this.children.set(id, []);
      if (nested.length) this.append(id, nested, undefined);
      ids.splice(at++, 0, id);
    }
    this.children.set(parent, ids);
  }

  /** Adds a block on the page as a person would (outside the tool's container). */
  personAddsParagraph(pageId: string, text: string) {
    this.append(
      pageId,
      [
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: text, link: null } }] },
        },
      ],
      undefined,
    );
  }

  container(pageId: string): StoredBlock {
    return (this.children.get(pageId) ?? [])
      .map((i) => this.blocks.get(i) as StoredBlock)
      .find((b) => b.type === 'quote') as StoredBlock;
  }
}

function setup(language: 'ko' | 'en' = 'ko') {
  const notion = new FakeNotion();
  const { fetch } = fakeFetch(notion.handle);
  const ctx = sinkCtx(language);
  const sink = createNotionCaseSink({ token: 'secret_x', databaseId: 'db1' }, ctx, {
    fetch: fetch as (u: string, i?: RequestInit) => Promise<Response>,
  });
  return { notion, sink, ctx };
}

const c07 = baseCase();
const propsOf = (notion: FakeNotion, id: string) =>
  (notion.pages.get(id) as { properties: Record<string, Json> }).properties;
const text = (p: Json | undefined) =>
  ((p?.rich_text ?? p?.title ?? []) as { plain_text: string }[]).map((t) => t.plain_text).join('');

describe('Notion sink — schema, create and list', () => {
  it('§5 adds missing properties on first use, including the human 실행 결과 column', async () => {
    const { notion, sink, ctx } = setup();
    await sink.list(jiraSpec, signal());
    expect([...notion.props.keys()].sort()).toEqual(
      [
        'AC',
        'Case ID',
        'Code status',
        'Lifecycle',
        'Name',
        'Priority',
        'QTG data',
        'Spec',
        'Technique',
        '실행 결과',
      ].sort(),
    );
    expect(notion.props.get(PROP.priority)).toBe('select');
    const patch = notion.writes.find((w) => w.path === 'data_sources/ds1')?.body.properties as Json;
    expect(patch[PROP.exec]).toEqual({
      select: { options: [{ name: '미실행' }, { name: 'Pass' }, { name: 'Fail' }, { name: 'Blocked' }] },
    });
    expect(ctx.logger.lines).toContain('info: Notion: added 9 propert(ies) to the QA case database.');
  });

  it('§5 names the missing properties when it cannot add them', async () => {
    const { notion, sink } = setup();
    notion.failSchema = true;
    const err = (await sink.list(jiraSpec, signal()).catch((e: unknown) => e)) as QtgError;
    expect(err).toBeInstanceOf(QtgError);
    expect(err.code).toBe('config_invalid');
    expect(err.userMessage).toMatch(
      /missing "Case ID" \(rich_text\).*"실행 결과" \(select\).*could not add them/,
    );
  });

  it('§5 writes into the column types a team already has, and skips types it cannot write', async () => {
    const { notion, sink, ctx } = setup();
    notion.props = new Map([
      ['Case', 'title'],
      [PROP.technique, 'rich_text'],
      [PROP.priority, 'multi_select'],
      [PROP.codeStatus, 'number'],
    ]);
    const c = { ...c07, codeStatus: { status: 'missing' as const, evidence: 'x', files: [], sha: 'abc' } };
    const { ticketRef } = await sink.create(jiraSpec, c, render(c), signal());
    const props = propsOf(notion, ticketRef);
    expect(text(props.Case)).toBe('만료 1초 지난 쿠폰 적용 시 거부');
    expect(text(props[PROP.technique])).toBe('경계값');
    expect(props[PROP.priority]).toMatchObject({ multi_select: [{ name: 'P0' }] });
    expect(props[PROP.codeStatus]).toBeUndefined();
    expect(ctx.logger.lines).toContain(
      'warn: Notion: property "Code status" has type number; the sink leaves it empty.',
    );
    const [t] = await sink.list(jiraSpec, signal());
    expect(t?.currentHash).toBe(t?.writtenHash);
  });

  it('§5 fails clearly when the database has no data source', async () => {
    const { notion, sink } = setup();
    const original = notion.handle;
    const { fetch } = fakeFetch((req) =>
      req.url.pathname === '/v1/databases/db1'
        ? json({ object: 'database', id: 'db1', data_sources: [] })
        : original(req),
    );
    const s2 = createNotionCaseSink({ token: 't', databaseId: 'db1' }, sinkCtx(), {
      fetch: fetch as (u: string, i?: RequestInit) => Promise<Response>,
    });
    await expect(s2.list(jiraSpec, signal())).rejects.toThrow(/no data source/);
    expect(sink.isConfigured()).toBe(true);
  });

  it('§5 creates a row with tool-owned properties and the case in one tagged container block', async () => {
    const { notion, sink } = setup();
    const r = render(c07);
    const { ticketRef, url } = await sink.create(jiraSpec, c07, r, signal());
    expect(url).toBe(`https://www.notion.so/${ticketRef}`);
    const props = propsOf(notion, ticketRef);
    expect(text(props.Name)).toBe('만료 1초 지난 쿠폰 적용 시 거부');
    expect(text(props[PROP.caseId])).toBe('PROJ-123-C07');
    expect(text(props[PROP.spec])).toBe('PROJ-123');
    expect(text(props[PROP.ac])).toBe('AC3');
    expect(props[PROP.technique]).toMatchObject({ select: { name: '경계값' } });
    expect(props[PROP.priority]).toMatchObject({ select: { name: 'P0' } });
    expect(props[PROP.lifecycle]).toMatchObject({ select: { name: '활성' } });
    expect(props[PROP.codeStatus]).toMatchObject({ select: null });
    expect(props[PROP.exec]).toBeUndefined();
    const container = notion.container(ticketRef);
    expect(text(container.quote as Json)).toBe('PROJ-123-C07');
    const body = (notion.children.get(container.id) ?? []).map((i) => notion.blocks.get(i)?.type);
    expect(body.slice(0, 3)).toEqual(['heading_3', 'bulleted_list_item', 'bulleted_list_item']);
  });

  it('§4.5 round trip: after Notion re-splits the text, list() reports the row unedited', async () => {
    const { notion, sink } = setup();
    const r = render(c07);
    const { ticketRef } = await sink.create(jiraSpec, c07, r, signal());
    const container = notion.container(ticketRef);
    const first = notion.blocks.get(notion.children.get(container.id)?.[1] ?? '') as StoredBlock;
    expect(((first.bulleted_list_item as Json).rich_text as unknown[]).length).toBeGreaterThan(1); // really split
    const [t] = await sink.list(jiraSpec, signal());
    expect(t).toMatchObject({ caseId: 'PROJ-123-C07', ticketRef, writtenHash: r.hash, currentHash: r.hash });
    expect(t?.lastWritten).toEqual(c07);
  });

  it('§4.5 one changed character in the container shows as edited; a block added elsewhere does not', async () => {
    const { notion, sink } = setup();
    const r = render(c07);
    const { ticketRef } = await sink.create(jiraSpec, c07, r, signal());
    notion.personAddsParagraph(ticketRef, 'QA 메모: 스테이징 재확인');
    expect((await sink.list(jiraSpec, signal()))[0]?.currentHash).toBe(r.hash);

    const container = notion.container(ticketRef);
    const step = (notion.children.get(container.id) ?? [])
      .map((i) => notion.blocks.get(i) as StoredBlock)
      .find((b) => b.type === 'numbered_list_item') as StoredBlock;
    const rich = (
      step.numbered_list_item as { rich_text: { plain_text: string; text: { content: string } }[] }
    ).rich_text;
    const run = rich[0] as { plain_text: string; text: { content: string } };
    run.plain_text = run.plain_text.replace('결제', '결재');
    expect((await sink.list(jiraSpec, signal()))[0]?.currentHash).toMatch(/^edited:/);
  });

  it('§4.6 ignores rows another user created, and pages through more than 100 rows', async () => {
    const { notion, sink, ctx } = setup();
    for (let i = 1; i <= 120; i++) {
      const c = baseCase({ caseId: `PROJ-123-C${String(i).padStart(3, '0')}` });
      await sink.create(jiraSpec, c, render(c), signal());
    }
    notion.actor = 'user-mallory';
    await sink.create(jiraSpec, baseCase({ caseId: 'PROJ-123-C999' }), render(c07), signal());
    notion.actor = notion.bot;
    const tickets = await sink.list(jiraSpec, signal());
    expect(tickets).toHaveLength(120);
    expect(tickets[0]?.caseId).toBe('PROJ-123-C001');
    expect(ctx.logger.lines.some((l) => l.startsWith('warn: Notion: ignored 1 row(s)'))).toBe(true);
    expect(await sink.list(githubSpec, signal())).toEqual([]);
  });
});

describe('Notion sink — update, suggest, obsolete', () => {
  it('§4.2 update rewrites tool properties and swaps the container in place; 실행 결과, 담당자 and notes stay', async () => {
    const { notion, sink } = setup();
    const { ticketRef } = await sink.create(jiraSpec, c07, render(c07), signal());
    const props = propsOf(notion, ticketRef);
    props[PROP.exec] = { type: 'select', select: { name: 'Fail' } };
    props[PROP.assignee] = { type: 'people', people: [{ name: 'QA Mina' }] };
    notion.personAddsParagraph(ticketRef, 'QA 메모');
    const [t] = await sink.list(jiraSpec, signal());
    expect(t?.human).toEqual({ execStatus: 'Fail', assignee: 'QA Mina' });

    const next = { ...c07, priority: 'P1' as const, steps: [...c07.steps, '결제 버튼 클릭'] };
    const r2 = render(next);
    const oldContainer = notion.container(ticketRef).id;
    notion.writes = [];
    await sink.update(t as NonNullable<typeof t>, next, r2, signal());

    const patch = notion.writes.find((w) => w.method === 'PATCH' && w.path === `pages/${ticketRef}`)?.body
      .properties as Json;
    expect(Object.keys(patch)).not.toContain(PROP.exec);
    expect(Object.keys(patch)).not.toContain(PROP.assignee);
    expect(props[PROP.exec]).toEqual({ type: 'select', select: { name: 'Fail' } });
    expect(props[PROP.priority]).toMatchObject({ select: { name: 'P1' } });
    const top = (notion.children.get(ticketRef) ?? []).map((i) => notion.blocks.get(i) as StoredBlock);
    expect(top.map((b) => b.type)).toEqual(['quote', 'paragraph']); // container first, the note kept
    expect(top[0]?.id).not.toBe(oldContainer);
    expect(
      notionPlain(
        (notion.children.get(top[0]?.id ?? '') ?? []).map((i) => notion.blocks.get(i) as StoredBlock),
      ),
    ).toContain('결제 버튼 클릭');
    const [after] = await sink.list(jiraSpec, signal());
    expect(after?.currentHash).toBe(r2.hash);
  });

  it('§4.5 suggest keeps one proposal comment, updated in place, and does not touch the row', async () => {
    const { notion, sink } = setup();
    const { ticketRef } = await sink.create(jiraSpec, c07, render(c07), signal());
    const [t] = await sink.list(jiraSpec, signal());
    const before = JSON.stringify(notion.pages.get(ticketRef));
    const v2 = render({ ...c07, steps: ['결제 화면 진입', '쿠폰 붙여넣기'] });
    await sink.suggest(t as NonNullable<typeof t>, c07, v2, signal());
    await sink.suggest(t as NonNullable<typeof t>, c07, v2, signal());
    await sink.suggest(t as NonNullable<typeof t>, c07, render({ ...c07, steps: ['다른 단계'] }), signal());
    expect(notion.comments).toHaveLength(1);
    const plain = notion.comments[0]?.rich_text.map((r) => r.plain_text).join('');
    expect(plain).toContain('도구 제안 변경');
    expect(plain).toContain('1. 다른 단계');
    expect(JSON.stringify(notion.pages.get(ticketRef))).toBe(before);
  });

  it('§4.4 markObsolete prefixes the title and sets Lifecycle without deleting the row', async () => {
    const { notion, sink } = setup();
    const { ticketRef } = await sink.create(jiraSpec, c07, render(c07), signal());
    const [t] = await sink.list(jiraSpec, signal());
    await sink.markObsolete(t as NonNullable<typeof t>, signal());
    await sink.markObsolete(t as NonNullable<typeof t>, signal());
    const props = propsOf(notion, ticketRef);
    expect(text(props.Name)).toBe('[해당 없음]만료 1초 지난 쿠폰 적용 시 거부');
    expect(props[PROP.lifecycle]).toMatchObject({ select: { name: '해당 없음' } });
    expect(notion.pages.has(ticketRef)).toBe(true);
    const [obs] = await sink.list(jiraSpec, signal());
    expect(obs?.lastWritten?.lifecycle).toBe('obsolete');
    expect(obs?.currentHash).toBe(obs?.writtenHash);
  });

  it('§5 has no spec-side summary (the database is shared) and is unconfigured without options', async () => {
    const { notion, sink } = setup();
    const res = await sink.publishSummary(
      jiraSpec,
      {
        specRef: jiraSpec,
        specTitle: 'x',
        language: 'ko',
        cases: [],
        counts: { total: 0, byPriority: { P0: 0, P1: 0, P2: 0 }, obsolete: 0 },
        meta: { model: 'm', costUsd: 0, mode: 'plan' },
      },
      signal(),
    );
    expect(res).toEqual({});
    expect(notion.writes).toEqual([]);
    expect(createNotionCaseSink(null, sinkCtx()).isConfigured()).toBe(false);
  });

  it('§5 reports a missing permission on create clearly', async () => {
    const { notion, sink } = setup();
    await sink.list(jiraSpec, signal()); // schema ready
    const original = notion.handle;
    notion.handle = (req) =>
      req.method === 'POST' && req.url.pathname === '/v1/pages'
        ? json({ object: 'error', status: 403, code: 'restricted_resource', message: 'x' }, 403)
        : original(req);
    const { fetch } = fakeFetch((req) => notion.handle(req));
    const s2 = createNotionCaseSink({ token: 't', databaseId: 'db1' }, sinkCtx(), {
      fetch: fetch as (u: string, i?: RequestInit) => Promise<Response>,
    });
    const err = (await s2.create(jiraSpec, c07, render(c07), signal()).catch((e: unknown) => e)) as QtgError;
    expect(err.userMessage).toBe(
      'Notion sink: permission denied while creating a case row (HTTP 403). The token needs write access to the case tickets.',
    );
  });
});
