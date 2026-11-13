import { describe, expect, it } from 'vitest';
import type { AdfNode } from '../../src/context/prd/adf-to-md';
import { adfToMarkdown } from '../../src/context/prd/adf-to-md';
import type { CaseSetSummary } from '../../src/core/cases';
import { QtgError } from '../../src/core/errors';
import { adfPlain, createJiraCaseSink, splitDescription } from '../../src/sinks/jira';
import { fakeFetch, json, type RecordedRequest } from '../context/helpers';
import { baseCase, githubSpec, instant, jiraSpec, render, signal, sinkCtx } from './support';

const BASE = 'https://acme.atlassian.net';

interface Issue {
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
function normalize(nodes: AdfNode[]): AdfNode[] {
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

class FakeJira {
  issues = new Map<string, Issue>();
  comments = new Map<string, { id: string; author: { accountId: string }; body: unknown }[]>();
  writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  account = 'acc-bot';
  rejectPriority = false;
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
      return json({
        issues: page,
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

function setup(language: 'ko' | 'en' = 'ko') {
  const jira = new FakeJira();
  const { fetch } = fakeFetch(jira.handle);
  const ctx = sinkCtx(language);
  const sink = createJiraCaseSink(
    { baseUrl: BASE, email: 'bot@example.invalid', apiToken: 'tok', subtaskType: 'QA Sub-task' },
    ctx,
    { fetch: fetch as typeof globalThis.fetch, retry: instant },
  );
  return { jira, sink, ctx };
}

const c07 = baseCase();

describe('Jira sink — create and list', () => {
  it('§5 creates a sub-task of the spec story with labels, priority and an ADF description ending in the payload', async () => {
    const { jira, sink } = setup();
    const r = render(c07);
    const res = await sink.create(jiraSpec, c07, r, signal());
    expect(res).toEqual({ ticketRef: 'PROJ-200', url: `${BASE}/browse/PROJ-200` });
    const sent = jira.writes.find((w) => w.path === '/rest/api/3/issue')?.body.fields as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({
      project: { key: 'PROJ' },
      parent: { key: 'PROJ-123' },
      issuetype: { name: 'QA Sub-task' },
      summary: r.title,
      labels: ['qtg-case', 'qtg-PROJ-123-C07'],
      priority: { name: 'Highest' },
    });
    const content = (sent.description as { content: AdfNode[] }).content;
    expect(content.at(-1)?.type).toBe('expand');
    expect(adfToMarkdown({ type: 'doc', content: content.slice(0, -1) })).toContain('1. 결제 화면 진입');
  });

  it('§4.5 round trip: after Jira normalizes the description, list() still reports it unedited', async () => {
    const { jira, sink } = setup();
    const r = render(c07);
    await sink.create(jiraSpec, c07, r, signal());
    // The fake really re-shaped the stored ADF.
    expect(JSON.stringify(jira.issues.get('PROJ-200')?.fields.description)).toContain('"localId":"srv"');
    const [t] = await sink.list(jiraSpec, signal());
    expect(t).toMatchObject({
      caseId: 'PROJ-123-C07',
      ticketRef: 'PROJ-200',
      writtenHash: r.hash,
      currentHash: r.hash,
      human: { execStatus: 'To Do' },
    });
    expect(t?.lastWritten).toEqual(c07);
  });

  it('§4.5 one changed character in the description or summary shows as edited', async () => {
    const { jira, sink } = setup();
    await sink.create(jiraSpec, c07, render(c07), signal());
    const issue = jira.issues.get('PROJ-200') as Issue;
    const json1 = JSON.stringify(issue.fields.description).replace('결제', '결재');
    issue.fields.description = JSON.parse(json1);
    expect((await sink.list(jiraSpec, signal()))[0]?.currentHash).toMatch(/^edited:/);
    issue.fields.description = JSON.parse(json1.replace('결재', '결제'));
    expect((await sink.list(jiraSpec, signal()))[0]?.currentHash).not.toMatch(/^edited:/);
    issue.fields.summary += '.';
    expect((await sink.list(jiraSpec, signal()))[0]?.currentHash).toMatch(/^edited:/);
  });

  it('§4.6 ignores sub-tasks created by another account', async () => {
    const { jira, sink, ctx } = setup();
    await sink.create(jiraSpec, c07, render(c07), signal());
    jira.account = 'acc-mallory';
    await sink.create(jiraSpec, baseCase({ caseId: 'PROJ-123-C08' }), render(c07), signal());
    jira.account = 'acc-bot';
    expect((await sink.list(jiraSpec, signal())).map((t) => t.caseId)).toEqual(['PROJ-123-C07']);
    expect(ctx.logger.lines.some((l) => l.startsWith('warn: Jira: ignored 1 sub-task(s)'))).toBe(true);
  });

  it('§4 pages through the JQL search with nextPageToken', async () => {
    const { sink } = setup();
    for (let i = 1; i <= 130; i++) {
      const c = baseCase({ caseId: `PROJ-123-C${String(i).padStart(3, '0')}` });
      await sink.create(jiraSpec, c, render(c), signal());
    }
    const tickets = await sink.list(jiraSpec, signal());
    expect(tickets).toHaveLength(130);
    expect(tickets.at(-1)?.caseId).toBe('PROJ-123-C130');
  });

  it('§5 falls back to qa-pN labels once when the sub-task screen has no priority field', async () => {
    const { jira, sink, ctx } = setup();
    jira.rejectPriority = true;
    await sink.create(jiraSpec, c07, render(c07), signal());
    const c08 = baseCase({ caseId: 'PROJ-123-C08', priority: 'P1' });
    await sink.create(jiraSpec, c08, render(c08), signal());
    expect(jira.issues.get('PROJ-200')?.fields.labels).toEqual(['qtg-case', 'qtg-PROJ-123-C07', 'qa-p0']);
    expect(jira.issues.get('PROJ-201')?.fields.labels).toEqual(['qtg-case', 'qtg-PROJ-123-C08', 'qa-p1']);
    // Only the very first create tried a priority.
    expect(
      jira.writes.filter(
        (w) => w.path === '/rest/api/3/issue' && (w.body.fields as { priority?: unknown }).priority,
      ),
    ).toHaveLength(1);
    expect(ctx.logger.lines.filter((l) => l.includes('does not accept a priority'))).toHaveLength(1);
  });

  it('§5 refuses a spec that is not a Jira issue, and is unconfigured without options', async () => {
    const { sink } = setup();
    await expect(sink.list(githubSpec, signal())).rejects.toThrow(/not a Jira issue/);
    expect(createJiraCaseSink(null, sinkCtx()).isConfigured()).toBe(false);
    await expect(createJiraCaseSink(null, sinkCtx()).list(jiraSpec, signal())).rejects.toBeInstanceOf(
      QtgError,
    );
  });

  it('§5 reports a missing create permission clearly', async () => {
    const { jira, sink } = setup();
    jira.failCreate = 403;
    const err = (await sink
      .create(jiraSpec, c07, render(c07), signal())
      .catch((e: unknown) => e)) as QtgError;
    expect(err.userMessage).toBe(
      'Jira sink: permission denied while creating a sub-task (HTTP 403). The token needs write access to the case tickets.',
    );
  });
});

describe('Jira sink — update, suggest, obsolete, summary', () => {
  it('§4.2 update keeps status, assignee, people’s labels and notes after the payload', async () => {
    const { jira, sink } = setup();
    await sink.create(jiraSpec, c07, render(c07), signal());
    const issue = jira.issues.get('PROJ-200') as Issue;
    issue.fields.status = { name: 'Failed' };
    issue.fields.assignee = { displayName: 'QA Mina' };
    issue.fields.labels.push('regression');
    issue.fields.description.content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: 'QA note: retest' }],
    });
    const [t] = await sink.list(jiraSpec, signal());
    expect(t?.human).toEqual({ execStatus: 'Failed', assignee: 'QA Mina' });

    const next = { ...c07, priority: 'P2' as const, expected: [...c07.expected, '주문 상태 변화 없음'] };
    const r2 = render(next);
    jira.writes = [];
    await sink.update(t as NonNullable<typeof t>, next, r2, signal());
    const put = jira.writes.find((w) => w.method === 'PUT')?.body as {
      fields: Record<string, unknown>;
      update?: unknown;
    };
    expect(Object.keys(put.fields).sort()).toEqual(['description', 'priority', 'summary']);
    expect(issue.fields.status).toEqual({ name: 'Failed' });
    expect(issue.fields.assignee).toEqual({ displayName: 'QA Mina' });
    expect(issue.fields.labels).toContain('regression');
    expect(issue.fields.priority).toEqual({ name: 'Medium' });
    const parts = splitDescription(issue.fields.description);
    expect(adfToMarkdown({ type: 'doc', content: parts.tool })).toContain('주문 상태 변화 없음');
    expect(adfPlain(parts.tail)).toContain('QA note: retest');
    const [after] = await sink.list(jiraSpec, signal());
    expect(after?.currentHash).toBe(r2.hash);
  });

  it('§4.5 suggest posts one proposal comment, updated in place, and leaves the description', async () => {
    const { jira, sink } = setup();
    await sink.create(jiraSpec, c07, render(c07), signal());
    const before = JSON.stringify(jira.issues.get('PROJ-200')?.fields.description);
    const [t] = await sink.list(jiraSpec, signal());
    const v2 = render({ ...c07, steps: ['결제 화면 진입', '쿠폰 붙여넣기'] });
    await sink.suggest(t as NonNullable<typeof t>, c07, v2, signal());
    await sink.suggest(t as NonNullable<typeof t>, c07, v2, signal());
    await sink.suggest(t as NonNullable<typeof t>, c07, render({ ...c07, steps: ['다른 단계'] }), signal());
    const comments = jira.comments.get('PROJ-200') ?? [];
    expect(comments).toHaveLength(1);
    expect(adfToMarkdown(comments[0]?.body)).toContain('다른 단계');
    expect(adfToMarkdown(comments[0]?.body)).toContain('도구 제안 변경');
    expect(JSON.stringify(jira.issues.get('PROJ-200')?.fields.description)).toBe(before);
    expect(jira.writes.filter((w) => w.method === 'POST' && w.path.endsWith('/comment'))).toHaveLength(1);
  });

  it('§4.4 markObsolete prefixes the summary and labels the sub-task without touching the status', async () => {
    const { jira, sink } = setup();
    const r = render(c07);
    await sink.create(jiraSpec, c07, r, signal());
    const issue = jira.issues.get('PROJ-200') as Issue;
    issue.fields.status = { name: 'In Progress' };
    const [t] = await sink.list(jiraSpec, signal());
    await sink.markObsolete(t as NonNullable<typeof t>, signal());
    expect(issue.fields.summary).toBe(`[해당 없음]${r.title}`);
    expect(issue.fields.labels).toContain('qtg-obsolete');
    expect(issue.fields.status).toEqual({ name: 'In Progress' });
    const [obs] = await sink.list(jiraSpec, signal());
    expect(obs?.lastWritten?.lifecycle).toBe('obsolete');
    expect(obs?.currentHash).toBe(obs?.writtenHash);
  });

  it('§5 keeps one summary comment on the story with links to the sub-tasks', async () => {
    const { jira, sink } = setup('en');
    const summary = (n: number): CaseSetSummary => ({
      specRef: jiraSpec,
      specTitle: 'Coupons',
      language: 'en',
      cases: [
        {
          caseId: 'PROJ-123-C07',
          title: `t${n}`,
          priority: 'P0',
          lifecycle: 'active',
          url: `${BASE}/browse/PROJ-200`,
        },
      ],
      counts: { total: 1, byPriority: { P0: 1, P1: 0, P2: 0 }, obsolete: 0 },
      meta: { model: 'm', costUsd: 0, mode: 'plan' },
    });
    const res = await sink.publishSummary(jiraSpec, summary(1), signal());
    await sink.publishSummary(jiraSpec, summary(2), signal());
    const comments = jira.comments.get('PROJ-123') ?? [];
    expect(comments).toHaveLength(1);
    const md = adfToMarkdown(comments[0]?.body);
    expect(md).toContain('[PROJ-200](https://acme.atlassian.net/browse/PROJ-200) [P0] PROJ-123-C07 t2');
    expect(md).toContain('qtg-summary:PROJ-123');
    expect(res.url).toBe(`${BASE}/browse/PROJ-123?focusedCommentId=1`);
    expect(await sink.publishSummary(githubSpec, summary(3), signal())).toEqual({});
  });
});
