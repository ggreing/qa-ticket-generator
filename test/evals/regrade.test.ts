import { describe, expect, it } from 'vitest';
import { gradeCase, withJudgeVerdicts } from '../../evals/grade';
import type { RunDeps, RunRecord } from '../../evals/run';
import { runEvals } from '../../evals/run';
import { type EvalCase, inputHashOf, loadCases } from '../../evals/schema';
import type { QaReport } from '../../src/core/contracts';
import { CASES_ROOT, nullReport, oracleReport } from './support';

const cases = loadCases(CASES_ROOT);
const caseOf = (id: string): EvalCase => cases.find((c) => c.id === id) as EvalCase;
const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A stored run as the runner writes it. `recorded` is the grade saved at the time of the run. */
function savedRun(c: EvalCase, report: QaReport, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    caseId: c.id,
    rep: 0,
    inputHash: inputHashOf(c),
    grade: gradeCase(c, { report, raw: report }),
    report,
    raw: report,
    calls: [],
    usage: ZERO,
    costUsd: 0.1,
    seconds: 50,
    warnings: [],
    ...overrides,
  };
}

function regrade(runs: RunRecord[], argv: string[] = []) {
  const lines: string[] = [];
  const written: string[] = [];
  const file = JSON.stringify({
    variants: [{ label: 'claude-opus-5-5 · high', runs, errors: [], costUsd: 1.43, judgeCostUsd: 0 }],
  });
  const forbidden = (): never => {
    throw new Error('a re-grade must not create engines, providers or judge clients');
  };
  const deps: RunDeps = {
    casesRoot: CASES_ROOT,
    resultsRoot: 'evals/results',
    env: {},
    print: (line) => void lines.push(line),
    now: () => 0,
    createEngine: forbidden,
    createProvider: forbidden,
    createJudgeClient: forbidden,
    writeFile: (path) => void written.push(path),
    readFile: (path) => {
      if (path !== 'saved.json') throw new Error('ENOENT');
      return file;
    },
  };
  return runEvals(['--regrade', 'saved.json', ...argv], deps).then((outcome) => ({
    outcome,
    lines,
    written,
    out: lines.join('\n'),
  }));
}

describe('--regrade (offline, no API call)', () => {
  it('re-grades stored reports with the current rules, without a key, an engine or a provider', async () => {
    const coupon = caseOf('coupon-expiry-missing');
    const timezone = caseOf('report-timezone');
    const { outcome, written, out } = await regrade([
      savedRun(coupon, oracleReport(coupon)),
      savedRun(timezone, nullReport('misaligned')),
    ]);
    expect(outcome).toMatchObject({ exitCode: 0, executed: false, estimateUsd: 0 });
    expect(written).toEqual([]);
    expect(outcome.regraded?.[0]?.runs.map((r) => [r.caseId, r.status, r.before, r.after])).toEqual([
      ['coupon-expiry-missing', 'regraded', true, true],
      ['report-timezone', 'regraded', false, false],
    ]);
    expect(out).toContain('Re-grade of saved.json (no API call)');
    expect(out).toContain('0 verdict(s) changed, 2 unchanged, 0 not re-graded');
    expect(out).toContain('| claude-opus-5-5 · high (as recorded) | 2 | 0 | 50% |');
    expect(out).toContain('| claude-opus-5-5 · high (re-graded) | 2 | 0 | 50% |');
    expect(out).not.toContain('NOTE:');
  });

  it('shows a verdict that flips when the expected answer was changed after the run', async () => {
    // Recorded under an older rule set that wanted AC3 "covered"; the current case expects "missing".
    const coupon = caseOf('coupon-expiry-missing');
    const report = oracleReport(coupon);
    const recorded = { ...gradeCase(coupon, { report, raw: report }), pass: false };
    const { outcome, out } = await regrade([savedRun(coupon, report, { grade: recorded })]);
    expect(outcome.regraded?.[0]?.runs[0]).toMatchObject({ status: 'regraded', before: false, after: true });
    expect(out).toMatch(/coupon-expiry-missing#1\s+FAIL → pass/);
    expect(out).toContain('1 verdict(s) changed, 0 unchanged, 0 not re-graded');
    expect(out).toContain('(as recorded) | 1 | 0 | 0% |');
    expect(out).toContain('(re-graded) | 1 | 0 | 100% |');
  });

  it('marks a run stale when the case inputs changed, and leaves it out of the re-graded numbers', async () => {
    const coupon = caseOf('coupon-expiry-missing');
    const timezone = caseOf('report-timezone');
    const { outcome, out } = await regrade([
      savedRun(coupon, oracleReport(coupon), { inputHash: 'an-older-version' }),
      savedRun(timezone, oracleReport(timezone)),
    ]);
    expect(outcome.regraded?.[0]?.runs[0]).toMatchObject({
      status: 'stale',
      before: true,
      after: null,
      grade: null,
    });
    expect(out).toMatch(
      /coupon-expiry-missing#1\s+stale: the case inputs changed after this run, not re-graded/,
    );
    expect(out).toContain('0 verdict(s) changed, 1 unchanged, 1 not re-graded');
    expect(out).toContain('(re-graded) | 1 | 0 | 100% |');
  });

  it('warns that staleness cannot be detected in files written before input hashes existed', async () => {
    const coupon = caseOf('coupon-expiry-missing');
    const { outcome, out } = await regrade([
      savedRun(coupon, oracleReport(coupon), { inputHash: undefined }),
    ]);
    expect(outcome.regraded?.[0]?.runs[0]?.status).toBe('regraded');
    expect(out).toContain('NOTE: this file was written before runs recorded an input hash.');
  });

  it('keeps judge verdicts that were already paid for, and skips cases that no longer exist', async () => {
    const coupon = caseOf('coupon-expiry-missing');
    const report = oracleReport(coupon);
    const judged = withJudgeVerdicts(gradeCase(coupon, { report, raw: report }), { expired: true });
    const { outcome, out } = await regrade([
      savedRun(coupon, report, { grade: judged }),
      savedRun(coupon, report, { caseId: 'deleted-case' }),
    ]);
    const [kept, gone] = outcome.regraded?.[0]?.runs ?? [];
    expect(kept?.grade?.scenarios.map((s) => s.judgeHit)).toEqual([true, false, false, false]);
    expect(kept?.grade?.scenarioRecallJudge).toBe(0.25);
    expect(gone).toMatchObject({ status: 'unknown_case', after: null });
    expect(out).toMatch(/deleted-case#1\s+skipped: no such case any more/);
  });

  it('reports an unreadable or malformed results file with exit code 2', async () => {
    const lines: string[] = [];
    const deps = {
      casesRoot: CASES_ROOT,
      print: (line: string) => void lines.push(line),
      readFile: (path: string) => {
        if (path === 'bad.json') return '{"variants": 3}';
        throw new Error('ENOENT');
      },
    } as unknown as RunDeps;
    expect(await runEvals(['--regrade', 'missing.json'], deps)).toMatchObject({
      exitCode: 2,
      executed: false,
    });
    expect(await runEvals(['--regrade', 'bad.json'], deps)).toMatchObject({ exitCode: 2 });
    expect(lines).toEqual([
      'Cannot re-grade: missing.json is not a readable eval results file.',
      'Cannot re-grade: bad.json is not a readable eval results file.',
    ]);
    expect(await runEvals(['--regrade'], deps)).toMatchObject({ exitCode: 2 });
  });
});

describe('inputHashOf', () => {
  it('covers what the model sees and ignores the expected answers', () => {
    const coupon = caseOf('coupon-expiry-missing');
    const hash = inputHashOf(coupon);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(inputHashOf({ ...coupon, expected: { ...coupon.expected, expectedAlignment: 'aligned' } })).toBe(
      hash,
    );
    expect(inputHashOf({ ...coupon, pr: { ...coupon.pr, body: `${coupon.pr.body} edited` } })).not.toBe(hash);
    expect(new Set(cases.map(inputHashOf)).size).toBe(cases.length);
  });
});

describe('--regrade --edited (results files without input hashes)', () => {
  it('leaves the named cases out as stale and drops the "no hashes" note', async () => {
    const coupon = caseOf('coupon-expiry-missing');
    const timezone = caseOf('report-timezone');
    const { outcome, out } = await regrade(
      [
        savedRun(coupon, oracleReport(coupon), { inputHash: undefined }),
        savedRun(timezone, oracleReport(timezone), { inputHash: undefined }),
      ],
      ['--edited', 'coupon-expiry-missing'],
    );
    expect(outcome.regraded?.[0]?.runs.map((r) => r.status)).toEqual(['stale', 'regraded']);
    expect(out).not.toContain('NOTE:');
    expect(out).toContain('0 verdict(s) changed, 1 unchanged, 1 not re-graded');
  });
});
