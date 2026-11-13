import { getOctokit } from '@actions/github';
import { describe, expect, it } from 'vitest';
import { QtgError } from '../../src/core/errors';
import { createGitHubIssueCaseSink, splitBody } from '../../src/sinks/github-issue';
import { fakeFetch, json, type RecordedRequest } from '../context/helpers';
import { baseCase, githubSpec, instant, jiraSpec, render, signal, sinkCtx } from './support';

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  user: { login: string };
  assignees: { login: string }[];
  html_url: string;
}
interface Comment {
  id: number;
  body: string;
  user: { login: string };
  html_url: string;
}

/** Stateful fake of the GitHub issues API for one repository (acme/shop). */
class FakeIssues {
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

function setup(language: 'ko' | 'en' = 'ko') {
  const gh = new FakeIssues();
  const { fetch } = fakeFetch(gh.handle);
  const ctx = sinkCtx(language);
  const sink = createGitHubIssueCaseSink(
    getOctokit('t', { request: { fetch } }),
    { owner: 'acme', repo: 'shop' },
    ctx,
    {
      retry: instant,
    },
  );
  return { gh, sink, ctx };
}

const c07 = baseCase({ specRef: 'acme/shop#12' });

describe('GitHub Issue sink — create and list', () => {
  it('§5 creates one issue per case with qa-case, qa-p0 and qtg-spec-<n> labels and the hidden payload', async () => {
    const { gh, sink } = setup();
    const r = render(c07);
    const res = await sink.create(githubSpec, c07, r, signal());
    const issue = gh.issues.get(Number(res.ticketRef)) as Issue;
    expect(res.url).toBe(`https://github.com/acme/shop/issues/${res.ticketRef}`);
    expect(issue.title).toBe(r.title);
    expect(issue.labels).toEqual(['qa-case', 'qa-p0', 'qtg-spec-12']);
    expect(gh.labels).toEqual(new Set(['qa-case', 'qa-p0', 'qtg-spec-12']));
    expect(issue.body.startsWith(r.markdown)).toBe(true);
    expect(issue.body).toContain('<!-- qtg-case:PROJ-123-C07 -->');
    expect(splitBody(issue.body).payload).toBeTruthy();
  });

  it('§4.5 round trip: right after a write, list() reports the ticket as unedited', async () => {
    const { sink } = setup();
    const r = render(c07);
    await sink.create(githubSpec, c07, r, signal());
    const [t] = await sink.list(githubSpec, signal());
    expect(t).toMatchObject({ caseId: 'PROJ-123-C07', writtenHash: r.hash, currentHash: r.hash, human: {} });
    expect(t?.lastWritten).toEqual(c07);
  });

  it('§4.5 one changed character in the body or title shows as edited; CRLF re-saves do not', async () => {
    const { gh, sink } = setup();
    const r = render(c07);
    const { ticketRef } = await sink.create(githubSpec, c07, r, signal());
    const issue = gh.issues.get(Number(ticketRef)) as Issue;

    issue.body = issue.body.replace(/\n/g, '\r\n');
    expect((await sink.list(githubSpec, signal()))[0]?.currentHash).toBe(r.hash);

    issue.body = issue.body.replace('결제 화면 진입', '결제 화면 집입');
    const edited = (await sink.list(githubSpec, signal()))[0];
    expect(edited?.currentHash).toMatch(/^edited:/);
    expect(edited?.currentHash).not.toBe(edited?.writtenHash);

    issue.body = issue.body.replace('결제 화면 집입', '결제 화면 진입');
    issue.title = `${issue.title}!`;
    expect((await sink.list(githubSpec, signal()))[0]?.currentHash).toMatch(/^edited:/);
  });

  it('§4.6 ignores marker issues created by anyone but the tool identity', async () => {
    const { gh, sink, ctx } = setup();
    await sink.create(githubSpec, c07, render(c07), signal());
    gh.me = 'mallory';
    await sink.create(
      githubSpec,
      baseCase({ caseId: 'PROJ-123-C08', specRef: 'acme/shop#12' }),
      render(c07),
      signal(),
    );
    gh.me = 'github-actions[bot]';
    const tickets = await sink.list(githubSpec, signal());
    expect(tickets.map((t) => t.caseId)).toEqual(['PROJ-123-C07']);
    expect(ctx.logger.lines).toContain(
      "warn: GitHub: ignored 1 case issue(s) not created by the tool's identity.",
    );
  });

  it('§4.6 trusts the GET /user login for personal tokens', async () => {
    const { gh, sink } = setup();
    gh.userStatus = 200;
    gh.me = 'qa-bot-user';
    await sink.create(githubSpec, c07, render(c07), signal());
    expect(await sink.list(githubSpec, signal())).toHaveLength(1);
  });

  it('§4 pages through more than 100 case issues in creation order', async () => {
    const { sink } = setup();
    for (let i = 1; i <= 130; i++) {
      const c = baseCase({ caseId: `PROJ-123-C${String(i).padStart(3, '0')}`, specRef: 'acme/shop#12' });
      await sink.create(githubSpec, c, render(c), signal());
    }
    const tickets = await sink.list(githubSpec, signal());
    expect(tickets).toHaveLength(130);
    expect(tickets[0]?.caseId).toBe('PROJ-123-C001');
    expect(tickets[129]?.caseId).toBe('PROJ-123-C130');
  });

  it('§5 labels a non-GitHub spec with a slug and keeps cases of other specs apart', async () => {
    const { gh, sink } = setup();
    const c = baseCase();
    const { ticketRef } = await sink.create(jiraSpec, c, render(c), signal());
    expect(gh.issues.get(Number(ticketRef))?.labels).toContain('qtg-spec-proj-123');
    expect(await sink.list(githubSpec, signal())).toEqual([]);
    expect(await sink.list(jiraSpec, signal())).toHaveLength(1);
  });
});

describe('GitHub Issue sink — update, suggest, obsolete', () => {
  it('§4.2 update rewrites title, body and tool labels only; people keep state, assignees, labels and notes', async () => {
    const { gh, sink } = setup();
    const { ticketRef } = await sink.create(githubSpec, c07, render(c07), signal());
    const issue = gh.issues.get(Number(ticketRef)) as Issue;
    // People act on the ticket.
    issue.state = 'closed';
    issue.assignees = [{ login: 'qa-mina' }];
    issue.labels.push('qa:pass', 'needs-design');
    issue.body = `${issue.body}\n\nQA note: retest on staging.`;
    const [t] = await sink.list(githubSpec, signal());
    expect(t?.human).toEqual({ execStatus: 'pass', assignee: 'qa-mina' });

    const next = { ...c07, priority: 'P1' as const, steps: [...c07.steps, '결제 버튼 클릭'] };
    const r2 = render(next);
    gh.writes = [];
    await sink.update(t as NonNullable<typeof t>, next, r2, signal());

    expect(issue.state).toBe('closed');
    expect(issue.assignees).toEqual([{ login: 'qa-mina' }]);
    expect(issue.labels.sort()).toEqual(['needs-design', 'qa-case', 'qa-p1', 'qa:pass', 'qtg-spec-12']);
    expect(issue.title).toBe(r2.title);
    expect(issue.body).toContain('결제 버튼 클릭');
    expect(issue.body.trimEnd().endsWith('QA note: retest on staging.')).toBe(true);
    const patches = gh.writes.filter((w) => w.method === 'PATCH');
    for (const p of patches) expect(Object.keys(p.body).sort()).toEqual(['body', 'title']);
    // Unedited again after the tool's own write.
    const [after] = await sink.list(githubSpec, signal());
    expect(after?.currentHash).toBe(r2.hash);
    expect(after?.writtenHash).toBe(r2.hash);
  });

  it('§4.5 suggest leaves the body alone and keeps one proposal comment, updated in place', async () => {
    const { gh, sink } = setup();
    const { ticketRef } = await sink.create(githubSpec, c07, render(c07), signal());
    const n = Number(ticketRef);
    const before = (gh.issues.get(n) as Issue).body;
    const [t] = await sink.list(githubSpec, signal());
    const v2 = render({ ...c07, steps: ['결제 화면 진입', '쿠폰 EXP1 붙여넣기'] });
    await sink.suggest(t as NonNullable<typeof t>, c07, v2, signal());
    await sink.suggest(t as NonNullable<typeof t>, c07, v2, signal());
    expect(gh.comments.get(n)).toHaveLength(1);
    expect(gh.comments.get(n)?.[0]?.body).toContain('도구 제안 변경');
    expect(gh.comments.get(n)?.[0]?.body).toContain('쿠폰 EXP1 붙여넣기');
    const v3 = render({ ...c07, steps: ['결제 화면 진입', '쿠폰 EXP2 입력'] });
    await sink.suggest(t as NonNullable<typeof t>, c07, v3, signal());
    expect(gh.comments.get(n)).toHaveLength(1);
    expect(gh.comments.get(n)?.[0]?.body).toContain('쿠폰 EXP2 입력');
    expect((gh.issues.get(n) as Issue).body).toBe(before);
    expect(gh.writes.filter((w) => w.method === 'POST' && w.path.endsWith('/comments'))).toHaveLength(1);
  });

  it('§4.4 markObsolete prefixes the title and labels the issue without closing it; revival undoes both', async () => {
    const { gh, sink } = setup();
    const r = render(c07);
    const { ticketRef } = await sink.create(githubSpec, c07, r, signal());
    const issue = gh.issues.get(Number(ticketRef)) as Issue;
    const [t] = await sink.list(githubSpec, signal());
    await sink.markObsolete(t as NonNullable<typeof t>, signal());
    await sink.markObsolete(t as NonNullable<typeof t>, signal());

    expect(issue.title).toBe(`[해당 없음]${r.title}`);
    expect(issue.state).toBe('open');
    expect(issue.labels).toContain('qtg-obsolete');
    const [obs] = await sink.list(githubSpec, signal());
    expect(obs?.lastWritten?.lifecycle).toBe('obsolete');
    expect(obs?.currentHash).toBe(obs?.writtenHash); // the tool's own change is not a person's edit

    await sink.update(obs as NonNullable<typeof obs>, c07, r, signal());
    expect(issue.title).toBe(r.title);
    expect(issue.labels).not.toContain('qtg-obsolete');
  });

  it('§4.4 markObsolete keeps a person’s body edit visible as an edit', async () => {
    const { gh, sink } = setup();
    const { ticketRef } = await sink.create(githubSpec, c07, render(c07), signal());
    const issue = gh.issues.get(Number(ticketRef)) as Issue;
    issue.body = issue.body.replace('결제 화면 진입', '결제 화면 진입함');
    const [t] = await sink.list(githubSpec, signal());
    await sink.markObsolete(t as NonNullable<typeof t>, signal());
    expect((await sink.list(githubSpec, signal()))[0]?.currentHash).toMatch(/^edited:/);
  });
});

describe('GitHub Issue sink — summary and errors', () => {
  it('§5 keeps one checklist comment on the spec issue, updated in place', async () => {
    const { gh, sink } = setup('en');
    const summary = (title: string) => ({
      specRef: githubSpec,
      specTitle: 'Coupons',
      language: 'en' as const,
      cases: [
        {
          caseId: 'C1',
          title,
          priority: 'P0' as const,
          lifecycle: 'active' as const,
          url: 'https://github.com/acme/shop/issues/101',
        },
        {
          caseId: 'C2',
          title: 'old',
          priority: 'P2' as const,
          lifecycle: 'obsolete' as const,
          url: 'https://github.com/acme/shop/issues/102',
        },
      ],
      counts: { total: 1, byPriority: { P0: 1, P1: 0, P2: 0 }, obsolete: 1 },
      meta: { model: 'm', costUsd: 0, mode: 'plan' as const },
    });
    const res = await sink.publishSummary(githubSpec, summary('expired coupon'), signal());
    await sink.publishSummary(githubSpec, summary('expired coupon rejected'), signal());
    const comments = gh.comments.get(12) ?? [];
    expect(comments).toHaveLength(1);
    expect(res.url).toBe('https://github.com/acme/shop/issues/12#c');
    expect(comments[0]?.body).toContain('- [ ] #101 [P0] C1 expired coupon rejected');
    expect(comments[0]?.body).toContain('- [x] ~~#102 [P2] C2 old~~');
    expect(comments[0]?.body).toContain('<!-- qtg-summary:acme/shop#12 -->');
  });

  it('§5 ignores a forged summary comment and writes its own', async () => {
    const { gh, sink } = setup();
    gh.comments.set(12, [
      { id: 1, body: '<!-- qtg-summary:acme/shop#12 --> fake', user: { login: 'mallory' }, html_url: 'x' },
    ]);
    const empty = {
      specRef: githubSpec,
      specTitle: 'x',
      language: 'ko' as const,
      cases: [],
      counts: { total: 0, byPriority: { P0: 0, P1: 0, P2: 0 }, obsolete: 0 },
      meta: { model: 'm', costUsd: 0, mode: 'plan' as const },
    };
    await sink.publishSummary(githubSpec, empty, signal());
    expect(gh.comments.get(12)).toHaveLength(2);
    expect(gh.comments.get(12)?.[0]?.body).toBe('<!-- qtg-summary:acme/shop#12 --> fake');
    expect(await sink.publishSummary(jiraSpec, empty, signal())).toEqual({});
  });

  it('§5 reports a missing write permission clearly', async () => {
    const { gh, sink } = setup();
    gh.failCreate = 403;
    const err = (await sink
      .create(githubSpec, c07, render(c07), signal())
      .catch((e: unknown) => e)) as QtgError;
    expect(err).toBeInstanceOf(QtgError);
    expect(err.userMessage).toBe(
      'GitHub Issue sink: permission denied while creating a case issue (HTTP 403). The token needs write access to the case tickets.',
    );
    expect(sink.isConfigured()).toBe(true);
  });
});
