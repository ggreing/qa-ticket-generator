/**
 * Contract between the sinks (a) and the sync engine (b): every sink, driven by session b's real
 * renderCase and planSync, must give the ops SPEC v3 §4 expects over a case's lifecycle.
 * Owner: qa-work-session-a.
 */
import { getOctokit } from '@actions/github';
import { describe, expect, it } from 'vitest';
import { planSync, renderCase } from '../../src/cases';
import type { CaseSink, QaCase, SyncOp } from '../../src/core/cases';
import type { PrdRef } from '../../src/core/contracts';
import { createGitHubIssueCaseSink } from '../../src/sinks/github-issue';
import { createJiraCaseSink } from '../../src/sinks/jira';
import { createNotionCaseSink } from '../../src/sinks/notion';
import { fakeFetch } from '../context/helpers';
import { FakeIssues } from './fake-github';
import { BASE, FakeJira } from './fake-jira';
import { FakeNotion, type StoredBlock } from './fake-notion';
import { baseCase, githubSpec, instant, jiraSpec, signal, sinkCtx } from './support';

interface Rig {
  sink: CaseSink;
  spec: PrdRef;
  c: QaCase;
  /** A person changes one character of the tool-owned text; returns the undo. */
  editOneChar: (ticketRef: string) => () => void;
}

const render = (c: QaCase) => renderCase(c, 'ko');
const kinds = (ops: SyncOp[]) => ops.map((o) => o.op);

function githubRig(): Rig {
  const gh = new FakeIssues();
  const { fetch } = fakeFetch(gh.handle);
  return {
    sink: createGitHubIssueCaseSink(
      getOctokit('t', { request: { fetch } }),
      { owner: 'acme', repo: 'shop' },
      sinkCtx(),
      { retry: instant },
    ),
    spec: githubSpec,
    c: baseCase({ specRef: githubSpec.id }),
    editOneChar: (ref) => {
      const issue = gh.issues.get(Number(ref));
      if (!issue) throw new Error('no issue');
      const before = issue.body;
      issue.body = before.replace('결제', '결재');
      return () => {
        issue.body = before;
      };
    },
  };
}

function jiraRig(): Rig {
  const jira = new FakeJira();
  const { fetch } = fakeFetch(jira.handle);
  return {
    sink: createJiraCaseSink(
      { baseUrl: BASE, email: 'e@example.invalid', apiToken: 't', subtaskType: 'Sub-task' },
      sinkCtx(),
      {
        fetch: fetch as typeof globalThis.fetch,
        retry: instant,
      },
    ),
    spec: jiraSpec,
    c: baseCase(),
    editOneChar: (ref) => {
      const issue = jira.issues.get(ref);
      if (!issue) throw new Error('no issue');
      const before = JSON.stringify(issue.fields.description);
      issue.fields.description = JSON.parse(before.replace('결제', '결재'));
      return () => {
        issue.fields.description = JSON.parse(before);
      };
    },
  };
}

function notionRig(): Rig {
  const notion = new FakeNotion();
  const { fetch } = fakeFetch(notion.handle);
  return {
    sink: createNotionCaseSink({ token: 't', databaseId: 'db1' }, sinkCtx(), {
      fetch: fetch as (u: string, i?: RequestInit) => Promise<Response>,
    }),
    spec: jiraSpec,
    c: baseCase(),
    editOneChar: (ref) => {
      const container = notion.container(ref);
      const block = (notion.children.get(container.id) ?? [])
        .map((i) => notion.blocks.get(i) as StoredBlock)
        .find((b) => JSON.stringify(b).includes('결제')) as StoredBlock;
      const before = JSON.stringify(block);
      const edited = JSON.parse(before.replace(/결제/g, '결재'));
      notion.blocks.set(block.id, edited);
      return () => notion.blocks.set(block.id, JSON.parse(before));
    },
  };
}

async function lifecycle(rig: Rig) {
  const { sink, spec, c } = rig;
  const s = signal();
  const { ticketRef } = await sink.create(spec, c, render(c), s);

  // §4.5 round trip: what the tool just wrote is unchanged.
  expect(kinds(planSync(await sink.list(spec, s), [c], render))).toEqual(['unchanged']);

  // §4.5 one character changed by a person → suggest, never update.
  const undo = rig.editOneChar(ticketRef);
  const changed = { ...c, expected: [...c.expected, '주문 상태 변화 없음'] };
  expect(kinds(planSync(await sink.list(spec, s), [changed], render))).toEqual(['suggest']);
  undo();

  // §4.2 a content change on an untouched ticket → update; afterwards unchanged again.
  const [updateOp] = planSync(await sink.list(spec, s), [changed], render);
  expect(updateOp?.op).toBe('update');
  if (updateOp?.op === 'update') await sink.update(updateOp.ticket, updateOp.case, render(updateOp.case), s);
  expect(kinds(planSync(await sink.list(spec, s), [changed], render))).toEqual(['unchanged']);

  // §4.4 the spec drops the case → obsolete once, then nothing more.
  const [obsoleteOp] = planSync(await sink.list(spec, s), [], render);
  expect(obsoleteOp?.op).toBe('obsolete');
  if (obsoleteOp?.op === 'obsolete') await sink.markObsolete(obsoleteOp.ticket, s);
  const after = await sink.list(spec, s);
  expect(after[0]?.lastWritten?.lifecycle).toBe('obsolete');
  expect(kinds(planSync(after, [], render))).not.toContain('obsolete');
}

describe('sinks × sync engine contract (session b renderCase / planSync)', () => {
  it('§4 GitHub Issue sink: unchanged → suggest on a 1-char edit → update → obsolete once', async () => {
    await lifecycle(githubRig());
  });

  it('§4 Jira sink: unchanged → suggest on a 1-char edit → update → obsolete once', async () => {
    await lifecycle(jiraRig());
  });

  it('§4 Notion sink: unchanged → suggest on a 1-char edit → update → obsolete once', async () => {
    await lifecycle(notionRig());
  });
});
