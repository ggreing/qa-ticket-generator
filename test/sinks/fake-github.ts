/** Stateful fake for the github-issue sink tests (no network). Owner: qa-work-session-a. */
import { json, type RecordedRequest } from '../context/helpers';

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  user: { login: string };
  assignees: { login: string }[];
  html_url: string;
}
export interface Comment {
  id: number;
  body: string;
  user: { login: string };
  html_url: string;
}

/** Stateful fake of the GitHub issues API for one repository (acme/shop). */
export class FakeIssues {
  issues = new Map<number, Issue>();
  comments = new Map<number, Comment[]>();
  labels = new Set<string>();
  writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  me = 'github-actions[bot]';
  /** GET /user status: 403 for GITHUB_TOKEN-style tokens. */
  userStatus = 403;
  failCreate?: number;
  private nextIssue = 100;
  private nextComment = 9000;

  handle = (req: RecordedRequest): Response => {
    const path = decodeURIComponent(req.url.pathname);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    if (req.method !== 'GET') this.writes.push({ method: req.method, path, body });
    if (path === '/user')
      return this.userStatus === 200 ? json({ login: this.me }) : json({ message: 'no' }, this.userStatus);
    const base = '/repos/acme/shop';
    if (req.method === 'POST' && path === `${base}/labels`) {
      const name = String(body.name);
      if (this.labels.has(name)) return json({ message: 'Validation Failed' }, 422);
      this.labels.add(name);
      return json({ name }, 201);
    }
    if (req.method === 'GET' && path === `${base}/issues`) {
      const want = (req.url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
      const all = [...this.issues.values()].filter((i) => want.every((l) => i.labels.includes(l)));
      const per = Number(req.url.searchParams.get('per_page') ?? 30);
      const page = Number(req.url.searchParams.get('page') ?? 1);
      const slice = all.slice((page - 1) * per, page * per);
      const more = page * per < all.length;
      const link = `<https://api.github.com${base}/issues?labels=${want.join(',')}&state=all&per_page=${per}&page=${page + 1}>; rel="next"`;
      return json(
        slice.map((i) => this.view(i)),
        200,
        more ? { link } : {},
      );
    }
    if (req.method === 'POST' && path === `${base}/issues`) {
      if (this.failCreate)
        return json({ message: 'Resource not accessible by integration' }, this.failCreate);
      const number = this.nextIssue++;
      const issue: Issue = {
        number,
        title: String(body.title),
        body: String(body.body ?? ''),
        labels: (body.labels as string[]) ?? [],
        state: 'open',
        user: { login: this.me },
        assignees: [],
        html_url: `https://github.com/acme/shop/issues/${number}`,
      };
      this.issues.set(number, issue);
      return json(this.view(issue), 201);
    }
    const one = path.match(new RegExp(`^${base}/issues/(\\d+)$`));
    if (one) {
      const issue = this.issues.get(Number(one[1]));
      if (!issue) return json({ message: 'Not Found' }, 404);
      if (req.method === 'GET') return json(this.view(issue));
      if (req.method === 'PATCH') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        return json(this.view(issue));
      }
    }
    const labelAdd = path.match(new RegExp(`^${base}/issues/(\\d+)/labels$`));
    if (labelAdd && req.method === 'POST') {
      const issue = this.issues.get(Number(labelAdd[1])) as Issue;
      for (const l of body.labels as string[]) if (!issue.labels.includes(l)) issue.labels.push(l);
      return json(issue.labels.map((name) => ({ name })));
    }
    const labelDel = path.match(new RegExp(`^${base}/issues/(\\d+)/labels/(.+)$`));
    if (labelDel && req.method === 'DELETE') {
      const issue = this.issues.get(Number(labelDel[1])) as Issue;
      if (!issue.labels.includes(labelDel[2] as string))
        return json({ message: 'Label does not exist' }, 404);
      issue.labels = issue.labels.filter((l) => l !== labelDel[2]);
      return json(issue.labels.map((name) => ({ name })));
    }
    const comments = path.match(new RegExp(`^${base}/issues/(\\d+)/comments$`));
    if (comments) {
      const n = Number(comments[1]);
      const list = this.comments.get(n) ?? [];
      if (req.method === 'GET') return json(list);
      const c: Comment = {
        id: this.nextComment++,
        body: String(body.body),
        user: { login: this.me },
        html_url: `https://github.com/acme/shop/issues/${n}#c`,
      };
      this.comments.set(n, [...list, c]);
      return json(c, 201);
    }
    const editComment = path.match(new RegExp(`^${base}/issues/comments/(\\d+)$`));
    if (editComment && req.method === 'PATCH') {
      const c = [...this.comments.values()].flat().find((x) => x.id === Number(editComment[1])) as Comment;
      c.body = String(body.body);
      return json(c);
    }
    return json({ message: `unhandled ${req.method} ${path}` }, 404);
  };

  private view(i: Issue) {
    return { ...i, labels: i.labels.map((name) => ({ name })) };
  }
}
