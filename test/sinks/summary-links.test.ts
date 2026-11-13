/**
 * Sandbox E2E findings (control, runs 43367678143 / 43368502793), reproduced with fakes:
 * 1. the spec-side summary lost its case links: the pipeline keeps one caseId → url map for all
 *    sinks, and the file sink's create() returns url '' after the GitHub sink wrote its URL;
 * 2. every created issue printed an octokit deprecation warning (55 cases → 55 lines).
 * Owner: qa-work-session-a.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOctokit } from '@actions/github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSync, renderCase } from '../../src/cases';
import { adfToMarkdown } from '../../src/context/prd/adf-to-md';
import type { CaseSetSummary, CaseSink, QaCase } from '../../src/core/cases';
import type { PrdRef } from '../../src/core/contracts';
import { syncSink } from '../../src/core/plan-pipeline';
import { createFileCaseSink } from '../../src/sinks/file';
import { createGitHubIssueCaseSink } from '../../src/sinks/github-issue';
import { createJiraCaseSink } from '../../src/sinks/jira';
import { fakeFetch, type RecordedRequest } from '../context/helpers';
import { silentLogger } from '../helpers/fakes';
import { FakeIssues } from './fake-github';
import { BASE, FakeJira } from './fake-jira';
import { baseCase, githubSpec, instant, jiraSpec, signal, sinkCtx } from './support';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qtg-summary-links-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const render = (c: QaCase) => renderCase(c, 'en');

function casesFor(spec: PrdRef, prefix: string): QaCase[] {
  return (['P0', 'P1', 'P2'] as const).map((priority, i) =>
    baseCase({ specRef: spec.id, caseId: `${prefix}-C0${i + 1}`, priority, title: `case ${i + 1}` }),
  );
}

/** The summary the plan pipeline builds (buildSummary): one url per case from the shared map. */
function summaryOf(spec: PrdRef, cases: QaCase[], urls: Map<string, string>): CaseSetSummary {
  return {
    specRef: spec,
    specTitle: 'Coupons',
    language: 'en',
    cases: cases.map((c) => ({
      caseId: c.caseId,
      title: c.title,
      priority: c.priority,
      lifecycle: c.lifecycle,
      url: urls.get(c.caseId),
    })),
    counts: { total: cases.length, byPriority: { P0: 1, P1: 1, P2: 1 }, obsolete: 0 },
    meta: { model: 'm', costUsd: 0, mode: 'plan' },
  };
}

/** Runs the real core syncSink for each sink in order, sharing one url map like runPlan. */
async function syncAll(sinks: CaseSink[], spec: PrdRef, cases: QaCase[]) {
  const urls = new Map<string, string>();
  const deps = { logger: silentLogger(), planSync };
  for (const sink of sinks) await syncSink(sink, null, cases, render, spec, urls, deps, signal());
  return urls;
}

function githubRig(handle?: (gh: FakeIssues, req: RecordedRequest) => Response) {
  const gh = new FakeIssues();
  const { fetch } = fakeFetch((req) => (handle ? handle(gh, req) : gh.handle(req)));
  const ctx = sinkCtx('en');
  const octokit = getOctokit('t', { request: { fetch } });
  const make = () =>
    createGitHubIssueCaseSink(octokit, { owner: 'acme', repo: 'shop' }, ctx, { retry: instant });
  return { gh, ctx, make };
}

describe('spec summary links (sandbox finding 1)', () => {
  it('§5 GitHub: links every case issue although the file sink, synced later, left an empty url', async () => {
    const { gh, make } = githubRig();
    const github = make();
    const file = createFileCaseSink({ dir, previous: null }, { logger: silentLogger(), language: 'en' });
    const cases = casesFor(githubSpec, 'acme-shop-12');

    const urls = await syncAll([github, file], githubSpec, cases);
    await github.publishSummary(githubSpec, summaryOf(githubSpec, cases, urls), signal());

    const body = gh.comments.get(12)?.[0]?.body ?? '';
    const numbers = [...gh.issues.values()].map((i) => i.number);
    expect(numbers).toHaveLength(3);
    for (const [i, c] of cases.entries()) {
      expect(body).toContain(`- [ ] #${numbers[i]} [${c.priority}] ${c.caseId} ${c.title}`);
    }
  });

  it('§2.2 GitHub: a later run that only lists the cases (verify) still links them, with no url at all', async () => {
    const { gh, make } = githubRig();
    const cases = casesFor(githubSpec, 'acme-shop-12');
    await syncAll([make()], githubSpec, cases);

    const nextRun = make();
    await nextRun.list(githubSpec, signal());
    await nextRun.publishSummary(githubSpec, summaryOf(githubSpec, cases, new Map()), signal());

    const body = gh.comments.get(12)?.[0]?.body ?? '';
    expect(body.match(/^- \[ \] #\d+ \[P\d\] /gm)).toHaveLength(3);
  });

  it('§5 GitHub: a case this sink has not seen keeps the url fallback', async () => {
    const { gh, make } = githubRig();
    const sink = make();
    const [c] = casesFor(githubSpec, 'acme-shop-12');
    const urls = new Map([[c?.caseId ?? '', 'https://github.com/other/repo/issues/7']]);
    await sink.publishSummary(githubSpec, summaryOf(githubSpec, c ? [c] : [], urls), signal());
    expect(gh.comments.get(12)?.[0]?.body).toContain('- [ ] other/repo#7 [P0]');
  });

  it('§5 Jira: links every sub-task on the story although the file sink left an empty url', async () => {
    const jira = new FakeJira();
    const { fetch } = fakeFetch(jira.handle);
    const sink = createJiraCaseSink(
      { baseUrl: BASE, email: 'e@example.invalid', apiToken: 't', subtaskType: 'Sub-task' },
      sinkCtx('en'),
      { fetch: fetch as typeof globalThis.fetch, retry: instant },
    );
    const file = createFileCaseSink({ dir, previous: null }, { logger: silentLogger(), language: 'en' });
    const cases = casesFor(jiraSpec, 'PROJ-123');

    const urls = await syncAll([sink, file], jiraSpec, cases);
    await sink.publishSummary(jiraSpec, summaryOf(jiraSpec, cases, urls), signal());

    const md = adfToMarkdown(jira.comments.get('PROJ-123')?.[0]?.body);
    const keys = [...jira.issues.keys()].filter((k) => k !== 'PROJ-123');
    expect(keys).toHaveLength(3);
    for (const [i, c] of cases.entries()) {
      expect(md).toContain(`[${keys[i]}](${BASE}/browse/${keys[i]}) [${c.priority}] ${c.caseId}`);
    }
  });
});

describe('octokit deprecation notices (sandbox finding 2)', () => {
  /** Every response says the endpoint is deprecated, like POST /issues did in the sandbox. */
  const deprecated = (gh: FakeIssues, req: RecordedRequest) => {
    const res = gh.handle(req);
    res.headers.set('deprecation', '@1773100800');
    res.headers.set('sunset', 'Fri, 10 Mar 2028 00:00:00 GMT');
    return res;
  };

  it('§5 go to debug once per endpoint instead of one warning per created issue', async () => {
    const { ctx, make } = githubRig(deprecated);
    const sink = make();
    const cases = [...casesFor(githubSpec, 'acme-shop-12'), ...casesFor(githubSpec, 'acme-shop-12-b')];
    const urls = await syncAll([sink], githubSpec, cases);
    await sink.publishSummary(githubSpec, summaryOf(githubSpec, cases, urls), signal());
    await sink.publishSummary(githubSpec, summaryOf(githubSpec, cases.slice(1), urls), signal());

    const notices = ctx.logger.lines.filter((l) => l.includes('is deprecated'));
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.filter((l) => !l.startsWith('debug: '))).toEqual([]);
    const createIssue = notices.filter((l) => /"POST [^"]*\/repos\/acme\/shop\/issues"/.test(l));
    expect(createIssue).toHaveLength(1);
  });

  it('§5 count an endpoint once whatever the issue number (three updates, one notice)', async () => {
    const { ctx, make } = githubRig(deprecated);
    const sink = make();
    const cases = casesFor(githubSpec, 'acme-shop-12');
    await syncAll([sink], githubSpec, cases);
    const changed = cases.map((c) => ({ ...c, expected: [...c.expected, 'No order is created'] }));
    await syncAll([sink], githubSpec, changed);

    const updates = ctx.logger.lines.filter(
      (l) => /is deprecated/.test(l) && /"PATCH [^"]*\/issues\/\d+"/.test(l),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/^debug: /);
  });

  it('§5 the scoped logger does not change where requests go (client fetch is kept)', async () => {
    const { gh, make } = githubRig(deprecated);
    await syncAll([make()], githubSpec, casesFor(githubSpec, 'acme-shop-12'));
    expect(gh.issues.size).toBe(3);
  });
});
