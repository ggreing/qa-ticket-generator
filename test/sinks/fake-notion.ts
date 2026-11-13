/** Stateful fake for the notion sink tests (no network). Owner: qa-work-session-a. */
import { json, type RecordedRequest } from '../context/helpers';

export type Json = Record<string, unknown>;
export interface StoredBlock {
  object: 'block';
  id: string;
  type: string;
  has_children: boolean;
  [k: string]: unknown;
}

/** Stores rich text like Notion: plain_text/href added, long runs split in two. */
export function storeRich(items: unknown): Json[] {
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

export class FakeNotion {
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
