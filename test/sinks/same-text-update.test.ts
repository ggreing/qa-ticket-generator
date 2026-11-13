/**
 * planSync sends `update` with unchanged text when only a tool field such as `specDigest` moved
 * (session b, SPEC v3 §4.2). The sinks refresh their record and leave what people see alone:
 * GitHub rewrites only the hidden payload comment, Jira sets an issue property (a description
 * rewrite would mail every watcher), Notion writes the row properties and keeps the page body.
 * Owner: qa-work-session-a.
 */
import { getOctokit } from '@actions/github';
import { describe, expect, it } from 'vitest';
import { planSync, renderCase } from '../../src/cases';
import type { CaseSink, QaCase, SyncOp } from '../../src/core/cases';
import type { PrdRef } from '../../src/core/contracts';
import { isObsoleteTitle, OBSOLETE_TICKET_LABEL } from '../../src/sinks/common';
import { createGitHubIssueCaseSink, splitBody } from '../../src/sinks/github-issue';
import { CASE_PROPERTY, createJiraCaseSink } from '../../src/sinks/jira';
import { createNotionCaseSink } from '../../src/sinks/notion';
import { fakeFetch } from '../context/helpers';
import { FakeIssues } from './fake-github';
import { BASE, FakeJira } from './fake-jira';
import { FakeNotion } from './fake-notion';
import { baseCase, githubSpec, instant, jiraSpec, signal, sinkCtx } from './support';

const render = (c: QaCase) => renderCase(c, 'ko');
const kinds = (ops: SyncOp[]) => ops.map((o) => o.op);

interface Rig {
  sink: CaseSink;
  spec: PrdRef;
  c: QaCase;
  /** Writes recorded by the fake so far. */
  writes: () => { method: string; path: string; body: unknown }[];
}

function githubRig() {
  const gh = new FakeIssues();
  const { fetch } = fakeFetch(gh.handle);
  const octokit = getOctokit('t', { request: { fetch } });
  const sink = createGitHubIssueCaseSink(octokit, { owner: 'acme', repo: 'shop' }, sinkCtx(), {
    retry: instant,
  });
  return {
    gh,
    rig: { sink, spec: githubSpec, c: baseCase({ specRef: githubSpec.id }), writes: () => gh.writes },
  };
}

function jiraRig() {
  const jira = new FakeJira();
  const { fetch } = fakeFetch(jira.handle);
  const sink = createJiraCaseSink(
    { baseUrl: BASE, email: 'e@example.invalid', apiToken: 't', subtaskType: 'Sub-task' },
    sinkCtx(),
    { fetch: fetch as typeof globalThis.fetch, retry: instant },
  );
  return { jira, rig: { sink, spec: jiraSpec, c: baseCase(), writes: () => jira.writes } };
}

function notionRig() {
  const notion = new FakeNotion();
  const { fetch } = fakeFetch(notion.handle);
  const sink = createNotionCaseSink({ token: 't', databaseId: 'db1' }, sinkCtx(), {
    fetch: fetch as (u: string, i?: RequestInit) => Promise<Response>,
  });
  return { notion, rig: { sink, spec: jiraSpec, c: baseCase(), writes: () => notion.writes } };
}

/** Creates the case with digest d1, then applies the digest-only update planSync gives for d2. */
async function digestOnlyUpdate(rig: Rig) {
  const { sink, spec } = rig;
  const c1 = { ...rig.c, specDigest: 'd1' };
  const { ticketRef } = await sink.create(spec, c1, render(c1), signal());
  const c2 = { ...c1, specDigest: 'd2' };
  const ops = planSync(await sink.list(spec, signal()), [c2], render);
  expect(kinds(ops)).toEqual(['update']);
  const before = rig.writes().length;
  const [op] = ops;
  if (op?.op === 'update') await sink.update(op.ticket, op.case, render(op.case), signal());
  return { ticketRef, c2, writes: rig.writes().slice(before) };
}

/** After the update: the record carries d2, nothing more to do, and people's edits still show. */
async function expectRecorded(rig: Rig, c2: QaCase, editOneChar: () => void) {
  const [t] = await rig.sink.list(rig.spec, signal());
  expect(t?.lastWritten?.specDigest).toBe('d2');
  expect(t?.currentHash).toBe(t?.writtenHash);
  expect(kinds(planSync(await rig.sink.list(rig.spec, signal()), [c2], render))).toEqual(['unchanged']);
  editOneChar();
  const changed = { ...c2, expected: [...c2.expected, '주문 상태 변화 없음'] };
  expect(kinds(planSync(await rig.sink.list(rig.spec, signal()), [changed], render))).toEqual(['suggest']);
}

describe('digest-only updates (same text)', () => {
  it('§4.2 GitHub: one PATCH of the body, no title, tool text and people notes untouched', async () => {
    const { gh, rig } = githubRig();
    const c1 = { ...rig.c, specDigest: 'd1' };
    const { ticketRef } = await rig.sink.create(rig.spec, c1, render(c1), signal());
    const issue = gh.issues.get(Number(ticketRef));
    if (!issue) throw new Error('no issue');
    issue.body += '\n\n메모: 스테이징에서 재현됨';
    const before = { title: issue.title, ...splitBody(issue.body) };

    const c2 = { ...c1, specDigest: 'd2' };
    const ops = planSync(await rig.sink.list(rig.spec, signal()), [c2], render);
    expect(kinds(ops)).toEqual(['update']);
    const mark = gh.writes.length;
    const [op] = ops;
    if (op?.op === 'update') await rig.sink.update(op.ticket, op.case, render(op.case), signal());

    const writes = gh.writes.slice(mark);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `PATCH /repos/acme/shop/issues/${ticketRef}`,
    ]);
    expect(writes[0]?.body).not.toHaveProperty('title');
    const after = splitBody(issue.body);
    expect(issue.title).toBe(before.title);
    expect(after.tool).toBe(before.tool);
    expect(after.tail).toBe(before.tail);
    expect(after.payload).not.toBe(before.payload);

    await expectRecorded(rig, c2, () => {
      issue.body = issue.body.replace('결제', '결재');
    });
  });

  it('§4.2 Jira: sets the case property, never rewrites the description (no watcher mail)', async () => {
    const { jira, rig } = jiraRig();
    const { ticketRef, c2, writes } = await digestOnlyUpdate(rig);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `PUT /rest/api/3/issue/${ticketRef}/properties/${CASE_PROPERTY}`,
    ]);
    expect(jira.properties.get(ticketRef)?.[CASE_PROPERTY]).toMatchObject({
      v: 1,
      caseId: c2.caseId,
      case: { specDigest: 'd2' },
    });
    await expectRecorded(rig, c2, () => {
      const issue = jira.issues.get(ticketRef);
      if (!issue) throw new Error('no issue');
      issue.fields.description = JSON.parse(JSON.stringify(issue.fields.description).replace('결제', '결재'));
    });
  });

  it('§4.2 Jira: a text update after the property makes the description record win again', async () => {
    const { rig } = jiraRig();
    const { c2 } = await digestOnlyUpdate(rig);
    const c3 = { ...c2, specDigest: 'd3', expected: [...c2.expected, '쿠폰 사용 기록 없음'] };
    const [op] = planSync(await rig.sink.list(rig.spec, signal()), [c3], render);
    expect(op?.op).toBe('update');
    if (op?.op === 'update') await rig.sink.update(op.ticket, op.case, render(op.case), signal());
    const [t] = await rig.sink.list(rig.spec, signal());
    expect(t?.lastWritten?.specDigest).toBe('d3');
    expect(t?.lastWritten?.expected).toEqual(c3.expected);
    expect(kinds(planSync(await rig.sink.list(rig.spec, signal()), [c3], render))).toEqual(['unchanged']);
  });

  it('§4.2 Jira: falls back to the full update when the property cannot be set', async () => {
    const { jira, rig } = jiraRig();
    jira.rejectProperties = 403;
    const { ticketRef, c2, writes } = await digestOnlyUpdate(rig);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toContain(`PUT /rest/api/3/issue/${ticketRef}`);
    const [t] = await rig.sink.list(rig.spec, signal());
    expect(t?.lastWritten?.specDigest).toBe('d2');
    expect(kinds(planSync(await rig.sink.list(rig.spec, signal()), [c2], render))).toEqual(['unchanged']);
  });

  it('§4.2 Notion: patches the row properties only, the page body is not rewritten', async () => {
    const { notion, rig } = notionRig();
    const { ticketRef, c2, writes } = await digestOnlyUpdate(rig);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([`PATCH pages/${ticketRef}`]);
    await expectRecorded(rig, c2, () => {
      const container = notion.container(ticketRef);
      const id = notion.children
        .get(container.id)
        ?.find((i) => JSON.stringify(notion.blocks.get(i)).includes('결제'));
      const block = id ? notion.blocks.get(id) : undefined;
      if (!id || !block) throw new Error('no block');
      notion.blocks.set(id, JSON.parse(JSON.stringify(block).replace(/결제/g, '결재')));
    });
  });

  /** What people see on the ticket: its title, and whether the tool's obsolete label is on it. */
  type Shown = (ref: string) => { title: string; obsoleteLabel: boolean };
  const plain = (rich: unknown) =>
    ((rich as { plain_text?: string }[]) ?? []).map((t) => t.plain_text ?? '').join('');

  it.each<[string, () => { rig: Rig; shown: Shown }]>([
    [
      'GitHub',
      () => {
        const { gh, rig } = githubRig();
        return {
          rig,
          shown: (ref) => {
            const i = gh.issues.get(Number(ref));
            return {
              title: i?.title ?? '',
              obsoleteLabel: i?.labels.includes(OBSOLETE_TICKET_LABEL) ?? false,
            };
          },
        };
      },
    ],
    [
      'Jira',
      () => {
        const { jira, rig } = jiraRig();
        return {
          rig,
          shown: (ref) => {
            const i = jira.issues.get(ref);
            return {
              title: i?.fields.summary ?? '',
              obsoleteLabel: i?.fields.labels.includes(OBSOLETE_TICKET_LABEL) ?? false,
            };
          },
        };
      },
    ],
    [
      'Notion',
      () => {
        const { notion, rig } = notionRig();
        return {
          rig,
          shown: (ref) => {
            const props = (notion.pages.get(ref) as { properties?: Record<string, { title?: unknown }> })
              ?.properties;
            return { title: plain(props?.Name?.title), obsoleteLabel: false };
          },
        };
      },
    ],
  ])('§4.4 %s: a revived case is rewritten in full even though its text hash matches', async (_n, make) => {
    const { rig, shown } = make();
    const { sink, spec, c } = rig;
    const { ticketRef } = await sink.create(spec, c, render(c), signal());
    const [obsoleteOp] = planSync(await sink.list(spec, signal()), [], render);
    if (obsoleteOp?.op === 'obsolete') await sink.markObsolete(obsoleteOp.ticket, signal());
    expect(isObsoleteTitle(shown(ticketRef).title)).toBe(true); // the probe reads the real title
    const [revive] = planSync(await sink.list(spec, signal()), [c], render);
    expect(revive?.op).toBe('update');
    if (revive?.op === 'update') await sink.update(revive.ticket, revive.case, render(revive.case), signal());
    const [t] = await sink.list(spec, signal());
    expect(t?.lastWritten?.lifecycle).toBe('active');
    expect(isObsoleteTitle(shown(ticketRef).title)).toBe(false);
    expect(shown(ticketRef).obsoleteLabel).toBe(false);
    expect(t?.currentHash).toBe(t?.writtenHash);
    expect(kinds(planSync(await sink.list(spec, signal()), [c], render))).toEqual(['unchanged']);
  });
});
