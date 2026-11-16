/**
 * The Jira / Notion live check (evals/e2e/live-check.ts) run against the stateful fakes, so the
 * script is known to work before anyone points it at a real account. Owner: qa-work-session-a.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseArgs, runLiveCheck, type StepResult } from '../../evals/e2e/live-check';
import { fakeFetch } from '../context/helpers';
import { BASE, FakeJira } from '../sinks/fake-jira';
import { FakeNotion } from '../sinks/fake-notion';

const JIRA_ENV = {
  JIRA_BASE_URL: BASE,
  JIRA_EMAIL: 'bot@example.invalid',
  JIRA_API_TOKEN: 'jira-token-value',
  JIRA_PROJECT: 'PROJ',
};
const NOTION_ENV = { NOTION_TOKEN: 'notion-token-value', NOTION_QA_DATABASE_ID: 'db1' };
const instant = { sleep: async () => undefined };
const now = () => new Date('2026-11-16T09:30:00Z');

function rig() {
  const jira = new FakeJira();
  const notion = new FakeNotion();
  const j = fakeFetch(jira.handle);
  const n = fakeFetch(notion.handle);
  const fetch = ((input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input instanceof Request ? input.url : input)).host === 'api.notion.com'
      ? n.fetch(input, init)
      : j.fetch(input, init)) as typeof globalThis.fetch;
  const lines: string[] = [];
  return {
    jira,
    notion,
    fetch,
    lines,
    print: (l: string) => lines.push(l),
    calls: () => j.calls.length + n.calls.length,
  };
}

const statusOf = (results: StepResult[], target: string) =>
  results.filter((r) => r.target === target).map((r) => `${r.step}=${r.status}`);

describe('sinks live check — dry run', () => {
  it('v0.2 sends nothing without --yes, and says which variables are set (never their values)', async () => {
    const r = rig();
    const out = await runLiveCheck({
      yes: false,
      cleanup: false,
      env: { ...JIRA_ENV, ...NOTION_ENV },
      fetch: r.fetch,
      print: r.print,
    });
    expect(out.exitCode).toBe(0);
    expect(r.calls()).toBe(0);
    const text = r.lines.join('\n');
    expect(text).toContain('JIRA_API_TOKEN=set');
    expect(text).toContain('Dry run');
    expect(text).not.toContain('jira-token-value');
    expect(text).not.toContain('notion-token-value');
  });

  it('v0.2 with no variables there is nothing to check (exit 2)', async () => {
    const r = rig();
    const out = await runLiveCheck({ yes: true, cleanup: false, env: {}, fetch: r.fetch, print: r.print });
    expect(out.exitCode).toBe(2);
    expect(r.calls()).toBe(0);
  });

  it('v0.2 parses --yes, --cleanup and --only', () => {
    expect(parseArgs(['--yes', '--only', 'notion', '--cleanup'])).toEqual({
      yes: true,
      cleanup: true,
      only: 'notion',
    });
    expect(() => parseArgs(['--only', 'slack'])).toThrow(/jira or notion/);
  });
});

describe('sinks live check — against the fakes', () => {
  it('v0.2 Jira: creates a story, every automatic step passes, people fields need a manual look, cleanup closes', async () => {
    const r = rig();
    const out = await runLiveCheck({
      yes: true,
      cleanup: true,
      only: 'jira',
      env: JIRA_ENV,
      fetch: r.fetch,
      print: r.print,
      now,
      retry: instant,
    });
    expect(statusOf(out.results, 'jira')).toEqual([
      '0 story=PASS',
      '1 create=PASS',
      '2 list round trip=PASS',
      '3 same-text update=PASS',
      '4 people fields kept=PASS',
      '4 people fields kept=MANUAL',
      '5 one-char edit → suggest=PASS',
      '6 obsolete=PASS',
      '7 summary=PASS',
      'cleanup=PASS',
      'cleanup=PASS',
      'cleanup=PASS',
      'cleanup=PASS',
    ]);
    expect(out.exitCode).toBe(0);
    expect([...r.jira.issues.values()].every((i) => i.fields.status.name === 'Done')).toBe(true);
    expect(r.lines.join('\n')).not.toContain('jira-token-value');
  });

  it('v0.2 Jira: a broken property path is reported, not passed (watchers would be mailed)', async () => {
    const r = rig();
    r.jira.rejectProperties = 403;
    const out = await runLiveCheck({
      yes: true,
      cleanup: false,
      only: 'jira',
      env: JIRA_ENV,
      fetch: r.fetch,
      print: r.print,
      now,
      retry: instant,
    });
    const step3 = out.results.find((x) => x.step === '3 same-text update');
    expect(step3?.status).toBe('FAIL');
    expect(step3?.detail).toMatch(/qtg\.case is missing/);
    expect(out.exitCode).toBe(1);
  });

  it('v0.2 Notion: every automatic step passes, no spec-side summary by design, cleanup trashes the rows', async () => {
    const r = rig();
    const out = await runLiveCheck({
      yes: true,
      cleanup: true,
      only: 'notion',
      env: NOTION_ENV,
      fetch: r.fetch,
      print: r.print,
      now,
    });
    expect(statusOf(out.results, 'notion')).toEqual([
      '1 create=PASS',
      '2 list round trip=PASS',
      '3 same-text update=PASS',
      '4 people fields kept=PASS',
      '4 people fields kept=MANUAL',
      '5 one-char edit → suggest=PASS',
      '6 obsolete=PASS',
      '7 summary=SKIP',
      'cleanup=PASS',
      'cleanup=PASS',
      'cleanup=PASS',
    ]);
    expect(out.exitCode).toBe(0);
    expect([...r.notion.pages.values()].every((p) => p.in_trash === true)).toBe(true);
  });

  it('v0.2 an unreachable target fails its setup and the other one still runs', async () => {
    const r = rig();
    const broken = vi.fn(r.fetch);
    const fetch = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith(BASE)
        ? Promise.resolve(new Response('{}', { status: 401 }))
        : broken(input, init)) as typeof globalThis.fetch;
    const out = await runLiveCheck({
      yes: true,
      cleanup: false,
      env: { ...JIRA_ENV, ...NOTION_ENV },
      fetch,
      print: r.print,
      now,
      retry: instant,
    });
    expect(out.results.find((x) => x.target === 'jira')?.status).toBe('FAIL');
    expect(out.results.filter((x) => x.target === 'notion' && x.status === 'PASS').length).toBeGreaterThan(4);
    expect(out.exitCode).toBe(1);
  });
});
