/** Stateful fake for the jira sink tests (no network). Owner: qa-work-session-a. */
import type { AdfNode } from '../../src/context/prd/adf-to-md';
import { json, type RecordedRequest } from '../context/helpers';

export const BASE = 'https://acme.atlassian.net';

export interface Issue {
  key: string;
  fields: {
    summary: string;
    description: { type: 'doc'; version: 1; content: AdfNode[] };
    labels: string[];
    status: { name: string };
    assignee: { displayName: string } | null;
    creator: { accountId: string };
    parent: { key: string };
    priority?: { name: string };
    issuetype: { name: string };
  };
}

/** Re-shapes ADF the way Jira does on save: extra attrs everywhere, text split into runs. */
export function normalize(nodes: AdfNode[]): AdfNode[] {
  return nodes.flatMap((n) => {
    if (n.type === 'text' && typeof n.text === 'string' && n.text.length > 3) {
      const mid = Math.floor(n.text.length / 2);
      return [
        { ...n, text: n.text.slice(0, mid) },
        { ...n, text: n.text.slice(mid) },
      ];
    }
    const out: AdfNode = { ...n, attrs: { ...(n.attrs ?? {}), localId: 'srv' } };
    if (Array.isArray(n.content)) out.content = normalize(n.content as AdfNode[]);
    return [out];
  });
}

export class FakeJira {
  issues = new Map<string, Issue>();
  comments = new Map<string, { id: string; author: { accountId: string }; body: unknown }[]>();
  writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  account = 'acc-bot';
  rejectPriority = false;
  /** Issue entity properties, per issue key. */
  properties = new Map<string, Record<string, unknown>>();
  /** HTTP status for PUT …/properties/… (e.g. 403); unset = accepted. */
  rejectProperties?: number;
  failCreate?: number;
  private seq = 200;
  private cseq = 1;

  handle = (req: RecordedRequest): Response => {
    const path = decodeURIComponent(req.url.pathname);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    if (req.method !== 'GET') this.writes.push({ method: req.method, path, body });
    if (path === '/rest/api/3/myself') return json({ accountId: this.account });
    if (path === '/rest/api/3/search/jql' && req.method === 'POST') {
      const parent = String(body.jql).match(/parent = "([^"]+)"/)?.[1];
      const all = [...this.issues.values()].filter(
        (i) => i.fields.parent.key === parent && i.fields.labels.includes('qtg-case'),
      );
      const start = Number(body.nextPageToken ?? 0);
      const size = Number(body.maxResults ?? 50);
      const page = all.slice(start, start + size);
      // Like Jira: only the requested properties come back, and only when set.
      const wanted = Array.isArray(body.properties) ? (body.properties as string[]) : [];
      const withProps = page.map((i) => {
        const set = this.properties.get(i.key) ?? {};
        const props = Object.fromEntries(wanted.filter((k) => k in set).map((k) => [k, set[k]]));
        return Object.keys(props).length ? { ...i, properties: props } : i;
      });
      return json({
        issues: withProps,
        ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
      });
    }
    if (path === '/rest/api/3/issue' && req.method === 'POST') {
      if (this.failCreate) return json({ errorMessages: ['nope'] }, this.failCreate);
      const f = body.fields as Record<string, unknown>;
      if (f.priority && this.rejectPriority) {
        return json({ errorMessages: [], errors: { priority: "Field 'priority' cannot be set." } }, 400);
      }
      const key = `PROJ-${this.seq++}`;
      this.issues.set(key, {
        key,
        fields: {
          summary: String(f.summary),
          description: {
            ...(f.description as Issue['fields']['description']),
            content: normalize((f.description as { content: AdfNode[] }).content),
          },
          labels: [...(f.labels as string[])],
          status: { name: 'To Do' },
          assignee: null,
          creator: { accountId: this.account },
          parent: f.parent as { key: string },
          ...(f.priority ? { priority: f.priority as { name: string } } : {}),
          issuetype: f.issuetype as { name: string },
        },
      });
      return json({ id: '1', key, self: `${BASE}/rest/api/3/issue/${key}` }, 201);
    }
    const prop = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/properties\/([^/]+)$/);
    if (prop?.[1] && prop[2] && req.method === 'PUT') {
      if (!this.issues.has(prop[1])) return json({ errorMessages: ['Issue does not exist'] }, 404);
      if (this.rejectProperties) return json({ errorMessages: ['no'] }, this.rejectProperties);
      const set = this.properties.get(prop[1]) ?? {};
      const existed = prop[2] in set;
      set[prop[2]] = body;
      this.properties.set(prop[1], set);
      return new Response(null, { status: existed ? 200 : 201 });
    }
    const one = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/);
    if (one?.[1]) {
      const issue = this.issues.get(one[1]);
      if (!issue) return json({ errorMessages: ['Issue does not exist'] }, 404);
      if (req.method === 'GET') return json(issue);
      if (req.method === 'PUT') {
        const f = (body.fields ?? {}) as Record<string, unknown>;
        if (f.priority && this.rejectPriority) return json({ errors: { priority: 'cannot be set' } }, 400);
        if (typeof f.summary === 'string') issue.fields.summary = f.summary;
        if (f.description) {
          const d = f.description as { content: AdfNode[] };
          issue.fields.description = { type: 'doc', version: 1, content: normalize(d.content) };
        }
        if (f.priority) issue.fields.priority = f.priority as { name: string };
        for (const op of (body.update as { labels?: { add?: string; remove?: string }[] })?.labels ?? []) {
          if (op.add && !issue.fields.labels.includes(op.add)) issue.fields.labels.push(op.add);
          if (op.remove) issue.fields.labels = issue.fields.labels.filter((l) => l !== op.remove);
        }
        return new Response(null, { status: 204 });
      }
    }
    const comments = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/);
    if (comments?.[1]) {
      const list = this.comments.get(comments[1]) ?? [];
      if (req.method === 'GET') {
        const startAt = Number(req.url.searchParams.get('startAt') ?? 0);
        const max = Number(req.url.searchParams.get('maxResults') ?? 50);
        return json({ comments: list.slice(startAt, startAt + max), total: list.length, startAt });
      }
      const c = { id: String(this.cseq++), author: { accountId: this.account }, body: body.body };
      this.comments.set(comments[1], [...list, c]);
      return json(c, 201);
    }
    const editComment = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment\/(\d+)$/);
    if (editComment?.[1] && req.method === 'PUT') {
      const c = (this.comments.get(editComment[1]) ?? []).find((x) => x.id === editComment[2]);
      if (c) c.body = body.body;
      return json(c);
    }
    return json({ errorMessages: [`unhandled ${req.method} ${path}`] }, 404);
  };
}
