import { describe, expect, it, vi } from 'vitest';
import { compareWithLastKept, type RoundRecord } from '../../evals/rounds';
import { parseArgs, type RunRecord, runEvals, type SavedResults } from '../../evals/run';
import { DEV, harness, RUBRIC_COST } from './harness';
import { fakeRubricClient, type RubricBody } from './support';

type Harness = ReturnType<typeof harness>;
const forbidden = (): never => {
  throw new Error('a re-judge must not generate reports: no engine, no provider, no coverage judge');
};
const INDEX = 'evals/rounds/index.json';
const ROUND1 = 'evals/rounds/1/raw/results.json';

/** Makes stored results and round records look as rubric v1 wrote them: no coverage, no version. */
function asRubricV1(h: Harness): void {
  for (const path of Object.keys(h.files).filter((f) => f.endsWith('results.json'))) {
    const saved = JSON.parse(h.files[path] as string) as SavedResults;
    delete saved.rubricVersion;
    for (const variant of saved.variants) {
      for (const run of variant.runs) {
        if (!run.rubric) continue;
        const { coverage: _c, ...report } = run.rubric.report;
        const { coverage: _w, ...why } = report.why;
        const { rubricVersion: _v, coverageRisks: _r, ...rest } = run.rubric;
        const reportScore = (report.alignmentCorrectness + report.concision + report.honesty) / 3;
        run.rubric = {
          ...rest,
          report: { ...report, why },
          reportScore,
          overall: 0.5 * rest.scenarioScore + 0.5 * reportScore,
        };
      }
    }
    h.files[path] = JSON.stringify(saved);
  }
  if (h.files[INDEX]) {
    const records = JSON.parse(h.files[INDEX] as string) as RoundRecord[];
    for (const record of records) {
      delete record.rubricVersion;
      for (const v of record.variants) delete v.criteria?.coverage;
    }
    h.files[INDEX] = JSON.stringify(records);
  }
}

/** Round 1 run, recorded and kept under rubric v1; returns the harness that holds its files. */
async function keptRound1(): Promise<Harness> {
  const h = harness();
  await runEvals(['--yes', '--judge', '--round', '1', '--change', 'concision'], h.deps);
  await runEvals(['--round', '1', '--decision', 'keep'], h.deps);
  asRubricV1(h);
  return h;
}

/** A harness that shares `from`'s files and may only call the rubric judge. */
function judgeOnly(from: Harness, overrides: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness({
    createEngine: forbidden,
    createProvider: forbidden,
    createJudgeClient: forbidden,
    writeFile: from.deps.writeFile,
    readFile: from.deps.readFile,
    ...overrides,
  });
  return { ...h, files: from.files };
}

describe('--rejudge: plan and cost gate (M3.5 round 2)', () => {
  it('M3.5 without --yes it prints what would be judged and the judge cost, and calls nothing', async () => {
    const base = await keptRound1();
    const before = JSON.stringify(base.files);
    const h = judgeOnly(base);
    const outcome = await runEvals(['--rejudge', ROUND1, '--round', '1'], h.deps);

    expect(outcome).toMatchObject({ exitCode: 0, executed: false });
    expect(h.createRubricClient).not.toHaveBeenCalled();
    expect(JSON.stringify(base.files)).toBe(before);
    expect(h.lines[0]).toBe('Re-judge plan — rubric v2');
    expect(h.out()).toMatch(
      /source: evals\/rounds\/1\/raw\/results\.json \(prompt \S+, split dev, language en\)/,
    );
    expect(h.out()).toContain('judge model: claude-sonnet-5-5');
    expect(h.out()).toContain(`reports to judge: ${DEV.length}`);
    expect(h.out()).toContain('estimated run cost:   $0.00 (no report is generated)');
    expect(h.out()).toMatch(/estimated judge cost: ~\$\d+\.\d\d \(claude-sonnet-5-5 rubric judge\)/);
    expect(h.out()).toContain('the scores are recorded for round 1 beside its existing record');
    expect(h.lines.at(-1)).toBe('Nothing was sent to the API. Re-run with --yes to execute.');
    // Judge only: a few cents per report, and nothing for generation.
    expect(outcome.estimate?.runUsd).toBe(0);
    const perReport = outcome.estimateUsd / DEV.length;
    expect(perReport).toBeGreaterThan(0.01);
    expect(perReport).toBeLessThan(0.1);
    expect(outcome.estimate?.judgeUsd).toBe(outcome.estimateUsd);
  });

  it('M3.5 the estimate follows the judge model, and --rejudge with --round needs no --change', async () => {
    const base = await keptRound1();
    const sonnet = await runEvals(['--rejudge', ROUND1], judgeOnly(base).deps);
    const haiku = await runEvals(
      ['--rejudge', ROUND1, '--judge-model', 'claude-haiku-5-5'],
      judgeOnly(base).deps,
    );
    expect(haiku.estimateUsd).toBeLessThan(sonnet.estimateUsd / 10);
    expect(parseArgs(['--rejudge', 'r.json', '--round', '1'], { model: 'm', effort: 'high' })).toMatchObject({
      rejudge: 'r.json',
      round: 1,
      change: '',
    });
    expect(() => parseArgs(['--rejudge'], { model: 'm', effort: 'high' })).toThrow(
      '--rejudge needs a value.',
    );
  });

  it('M3.5 refuses without an API key, and explains an unreadable file with exit code 2', async () => {
    const base = await keptRound1();
    const noKey = judgeOnly(base, { env: {} });
    expect(await runEvals(['--rejudge', ROUND1, '--yes'], noKey.deps)).toMatchObject({
      exitCode: 1,
      executed: false,
    });
    expect(noKey.lines.at(-1)).toBe('Cannot execute: ANTHROPIC_API_KEY is not set.');
    expect(noKey.createRubricClient).not.toHaveBeenCalled();

    const bad = judgeOnly(base);
    expect(await runEvals(['--rejudge', 'nope.json', '--yes'], bad.deps)).toMatchObject({ exitCode: 2 });
    expect(bad.out()).toBe('Cannot re-judge: nope.json is not a readable eval results file.');
  });
});

describe('--rejudge: scoring stored reports again (M3.5 round 2)', () => {
  it('M3.5 with --yes it calls only the judge and writes a new results file; the source stays as it was', async () => {
    const base = await keptRound1();
    const source = base.files[ROUND1] as string;
    const original = JSON.parse(source) as SavedResults;
    const bodies: RubricBody[] = [];
    const h = judgeOnly(base, { createRubricClient: vi.fn(() => fakeRubricClient(2, bodies, 0)) });
    const outcome = await runEvals(['--rejudge', ROUND1, '--yes'], h.deps);

    expect(outcome).toMatchObject({ exitCode: 0, executed: true });
    expect(bodies).toHaveLength(DEV.length);
    expect(base.files[ROUND1]).toBe(source);
    const path = Object.keys(base.files).find((f) => f.endsWith('-rejudged.json')) as string;
    expect(path).toMatch(/^evals\/results\/2026-11-12T09-00-\d\d-000Z-rejudged\.json$/);
    expect(outcome.resultsPath?.replace(/\\/g, '/')).toBe(path);

    const result = JSON.parse(base.files[path] as string) as SavedResults;
    expect(result).toMatchObject({
      rubricVersion: 2,
      rejudgedFrom: ROUND1,
      judgeModel: 'claude-sonnet-5-5',
      promptVersion: original.promptVersion,
      startedAt: original.startedAt,
      split: 'dev',
    });
    expect(result.rejudgedAt).toMatch(/^2026-11-12T09:00:/);
    const [before, after] = [original.variants[0], result.variants[0]];
    expect(after?.runs.map((r) => r.caseId)).toEqual(before?.runs.map((r) => r.caseId));
    for (const [i, run] of (after?.runs ?? []).entries()) {
      const old = before?.runs[i] as RunRecord;
      // Same report, same grade, same generation cost: only the judge's part is new.
      expect(run.report).toEqual(old.report);
      expect(run.grade).toEqual(old.grade);
      expect(run.costUsd).toBe(old.costUsd);
      expect(run.comment).toBe(old.comment);
      expect(old.rubric?.report.coverage).toBeUndefined();
      expect(run.rubric).toMatchObject({ rubricVersion: 2, scenarioScore: 1.5 });
      expect(run.rubric?.report.coverage).toBe(0);
      expect(run.rubricJudge).toMatchObject({ model: 'claude-sonnet-5-5', costUsd: RUBRIC_COST });
    }
    // With ground truth the stored grade still decides alignment correctness: (2 + 1 + 2 + 0) / 4.
    const graded = after?.runs.find((r) => r.caseId === 'coupon-expiry-missing');
    expect(graded?.rubric).toMatchObject({ alignmentSource: 'grade', reportScore: 1.25 });
    const real = after?.runs.find((r) => r.caseId === 'real-demo-1');
    expect(real?.rubric).toMatchObject({ alignmentSource: 'judge', reportScore: 1.25 });

    expect(after?.rubric).toMatchObject({ judged: DEV.length, rubricVersion: 2 });
    expect(after?.rubric?.criteria.coverage).toBe(0);
    expect(after?.costUsd).toBe(before?.costUsd);
    expect(after?.judgeCostUsd).toBeCloseTo(DEV.length * RUBRIC_COST, 9);
    expect(after?.summary).toEqual(before?.summary);
    expect(h.out()).toContain('coupon-expiry-missing#1: overall 1.38, coverage 0');
    expect(h.out()).toContain(`Re-judged results written to ${outcome.resultsPath}`);
    expect(h.out()).toContain('| Variant | Runs | Errors | Overall |');
    // Without --round nothing about rounds is touched.
    expect(Object.keys(base.files).filter((f) => f.includes('rubric-v2'))).toEqual([]);
  });

  it('M3.5 leaves out runs it cannot judge fairly and never carries an old score into the new file', async () => {
    const base = await keptRound1();
    const saved = JSON.parse(base.files[ROUND1] as string) as SavedResults;
    const runs = saved.variants[0]?.runs as RunRecord[];
    (runs[0] as RunRecord).inputHash = '0000000000000000'; // the case was edited after the run
    (runs[1] as RunRecord).caseId = 'deleted-case';
    delete (runs[2] as RunRecord).comment; // written before runs stored the rendered comment
    const [stale, , noComment] = runs.map((r) => r.caseId);
    base.files[ROUND1] = JSON.stringify(saved);

    const h = judgeOnly(base);
    const outcome = await runEvals(['--rejudge', ROUND1, '--yes'], h.deps);
    expect(h.out()).toContain(`reports to judge: ${DEV.length - 3}`);
    expect(h.out()).toContain(`left out, the case's PR, files or PRD changed after the run: ${stale}#1`);
    expect(h.out()).toContain('left out, no such case on this machine: deleted-case#1');
    expect(h.out()).toContain(`left out, the run did not store the rendered comment: ${noComment}#1`);
    expect(h.rubricBodies).toHaveLength(DEV.length - 3);

    const result = outcome.variants?.[0];
    expect(result?.runs).toHaveLength(DEV.length);
    expect(result?.runs.slice(0, 3).map((r) => [r.rubric, r.rubricJudge])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(result?.rubric?.judged).toBe(DEV.length - 3);
    expect(result?.runs.slice(3).every((r) => r.rubric?.rubricVersion === 2)).toBe(true);
  });

  it('M3.5 a failed judge call leaves that report without a score and says so; nothing to judge is an error', async () => {
    const base = await keptRound1();
    let calls = 0;
    const flaky = fakeRubricClient();
    const h = judgeOnly(base, {
      createRubricClient: () => ({
        messages: {
          parse: async (body) => {
            if (++calls === 2) throw new Error('overloaded');
            return flaky.messages.parse(body);
          },
        },
      }),
    });
    const outcome = await runEvals(['--rejudge', ROUND1, '--yes', '--concurrency', '1'], h.deps);
    const runs = outcome.variants?.[0]?.runs ?? [];
    expect(runs[1]?.rubric).toBeUndefined();
    expect(runs[1]?.rubricJudge).toMatchObject({ error: 'Error', costUsd: 0 });
    expect(outcome.variants?.[0]?.rubric?.judged).toBe(DEV.length - 1);
    expect(h.out()).toContain(`${runs[1]?.caseId}#1: judge failed (Error)`);
    expect(h.lines.at(-2)).toBe(
      `1 report(s) have no rubric score and are left out of the rubric means: ${runs[1]?.caseId}#1 (Error).`,
    );
    expect(h.lines.at(-1)).toBe(
      `Score only those again with: --rejudge ${outcome.resultsPath} --cases ${runs[1]?.caseId}`,
    );

    const empty = harness();
    empty.files['old.json'] = JSON.stringify({
      promptVersion: 'x',
      split: 'dev',
      variants: [{ label: 'v', runs: [], errors: [] }],
    });
    expect(await runEvals(['--rejudge', 'old.json', '--yes'], empty.deps)).toMatchObject({
      exitCode: 2,
      executed: false,
    });
    expect(empty.lines.at(-1)).toBe('Nothing to judge.');
    expect(empty.createRubricClient).not.toHaveBeenCalled();
  });
});

describe('--rejudge --round: a baseline for the new rubric (M3.5 round 2)', () => {
  it('M3.5 records the re-scored round beside the original, with its change text and decision', async () => {
    const base = await keptRound1();
    const summaryBefore = base.files['evals/rounds/1/summary.md'];
    const h = judgeOnly(base);
    const outcome = await runEvals(['--rejudge', ROUND1, '--round', '1', '--yes'], h.deps);

    expect(outcome.resultsPath?.replace(/\\/g, '/')).toMatch(/\/rounds\/1\/raw\/results\.rubric-v2\.json$/);
    expect(Object.keys(base.files).sort()).toEqual([
      'evals/ROUNDS.md',
      'evals/rounds/1/raw/results.json',
      'evals/rounds/1/raw/results.rubric-v2.json',
      'evals/rounds/1/summary.md',
      'evals/rounds/1/summary.rubric-v2.md',
      'evals/rounds/index.json',
    ]);
    expect(base.files['evals/rounds/1/summary.md']).toBe(summaryBefore);
    expect(h.lines.at(-1)).toBe(
      'Round 1 re-scored with rubric v2: evals/rounds/1/summary.rubric-v2.md and evals/ROUNDS.md (decision: keep, as recorded for the round).',
    );

    const records = JSON.parse(base.files[INDEX] as string) as RoundRecord[];
    expect(records.map((r) => [r.round, r.rubricVersion, r.rejudged, r.decision, r.change])).toEqual([
      [1, undefined, undefined, 'keep', 'concision'],
      [1, 2, true, 'keep', 'concision'],
    ]);
    const [v1, v2] = records as [RoundRecord, RoundRecord];
    // Same reports: everything deterministic is identical; only the rubric scores differ.
    expect(v2.variants[0]).toMatchObject({
      runs: DEV.length,
      passRate: v1.variants[0]?.passRate,
      findingRecall: v1.variants[0]?.findingRecall,
      avgTickets: v1.variants[0]?.avgTickets,
      costUsd: v1.variants[0]?.costUsd,
      scenarioScore: 1.5,
    });
    expect(v2.variants[0]?.criteria?.coverage).toBe(1);
    expect(v1.variants[0]?.criteria?.coverage).toBeUndefined();

    const rows = (base.files['evals/ROUNDS.md'] as string).split('\n').filter((l) => /^\| \d/.test(l));
    expect(rows.map((r) => r.split(' | ').slice(5, 7))).toEqual([
      ['en', 'v1'],
      ['en', 'v2 (re-scored)'],
    ]);
    expect(rows.every((r) => r.endsWith('| keep |'))).toBe(true);
    const summary = base.files['evals/rounds/1/summary.rubric-v2.md'] as string;
    expect(summary).toContain('- Rubric judge: claude-sonnet-5-5, rubric v2 (re-scored, no new generation)');
    expect(summary).toContain('- Decision: keep');
    expect(summary).toContain('| Coverage | 1.00 |');
    expect(summary).not.toContain('Compared with the last kept round');

    // Doing it again replaces the v2 record instead of adding a third row.
    await runEvals(['--rejudge', ROUND1, '--round', '1', '--yes'], judgeOnly(base).deps);
    expect((JSON.parse(base.files[INDEX] as string) as RoundRecord[]).length).toBe(2);
  });

  it('M3.5 the next round is compared only with a baseline of the same rubric version', async () => {
    const base = await keptRound1();
    const shared = { writeFile: base.deps.writeFile, readFile: base.deps.readFile };

    // Round 2 is judged with v2 while round 1 only has v1 scores: no recommendation, and how to fix it.
    const early = harness(shared);
    await runEvals(['--yes', '--judge', '--round', '2', '--change', 'coverage'], early.deps);
    expect(early.lines.at(-1)).toBe(
      'No recommendation for round 2: Round 1 was scored with rubric v1 and this round with v2, and scores from different rubric versions are not comparable. Score round 1 again first: --rejudge evals/rounds/1/raw/results.json --round 1.',
    );

    await runEvals(['--rejudge', ROUND1, '--round', '1', '--yes'], judgeOnly(base).deps);
    // Round 2 again: a judge that now finds full coverage lifts the overall against round 1 (v2).
    const later = harness({ ...shared, createRubricClient: () => fakeRubricClient(0, [], 2) });
    await runEvals(['--yes', '--judge', '--round', '2', '--change', 'coverage'], later.deps);
    expect(later.out()).toContain('Compared with round 1 (the last one kept):');
    expect(later.out()).toContain(
      '| claude-opus-5-5 · high | Coverage (0–2) (context) | 1.00 | 2.00 | +1.00 |',
    );
    expect(later.out()).toContain('| claude-opus-5-5 · high | Concision (0–2) (context) | 1.00 | 1.00 | 0 |');
    expect(later.out()).toContain('Recommendation for round 2: KEEP.');

    const records = JSON.parse(base.files[INDEX] as string) as RoundRecord[];
    expect(records.map((r) => [r.round, r.rubricVersion ?? 1])).toEqual([
      [1, 1],
      [1, 2],
      [2, 2],
    ]);
    const round2 = records[2] as RoundRecord;
    expect(compareWithLastKept(round2, records.slice(0, 1)).recommendation).toBe('none'); // v1 only
    expect(compareWithLastKept(round2, records.slice(0, 2)).baseline).toBe(1);

    // One decision per round, whichever versions it was scored with.
    await runEvals(['--round', '1', '--decision', 'revert'], judgeOnly(base).deps);
    const after = JSON.parse(base.files[INDEX] as string) as RoundRecord[];
    expect(after.map((r) => [r.round, r.decision])).toEqual([
      [1, 'revert'],
      [1, 'revert'],
      [2, 'pending'],
    ]);
  });
});
