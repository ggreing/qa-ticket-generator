import { describe, expect, it } from 'vitest';
import { CALIBRATION_LIMIT, compareRatings, pickSamples, type ReviewPack } from '../../evals/review';
import {
  compareWithLastKept,
  formatComparison,
  type RoundRecord,
  type RoundVariant,
  renderRoundsIndex,
} from '../../evals/rounds';
import { parseArgs, type RunRecord, runEvals, type SavedResults } from '../../evals/run';
import { DEV, DEV_GRADED, dataset, graded, harness } from './harness';
import { fakeRubricClient, nullReport, oracleReport } from './support';

type Harness = ReturnType<typeof harness>;
const forbidden = (): never => {
  throw new Error('offline modes must not create engines, providers or judge clients');
};
/** Dependencies for an offline mode that reads and writes the same in-memory files as `from`. */
const offline = (from: Harness): Harness => {
  const h = harness({
    env: {},
    createEngine: forbidden,
    createProvider: forbidden,
    createJudgeClient: forbidden,
    createRubricClient: forbidden,
    writeFile: from.deps.writeFile,
    readFile: from.deps.readFile,
  });
  return { ...h, files: from.files };
};
const ROUND_ARGS = ['--yes', '--judge', '--round', '1', '--change', 'baseline | ticket format'];

describe('improvement rounds (M3.5, RUBRIC.md "Procedure")', () => {
  it('M3.5 --round writes the raw results, a summary and the cumulative ROUNDS.md', async () => {
    const h = harness();
    const outcome = await runEvals(ROUND_ARGS, h.deps);

    expect(outcome).toMatchObject({ exitCode: 0, executed: true });
    expect(outcome.resultsPath?.replace(/\\/g, '/')).toMatch(/\/rounds\/1\/raw\/results\.json$/);
    expect(Object.keys(h.files).sort()).toEqual([
      'evals/ROUNDS.md',
      'evals/rounds/1/raw/results.json',
      'evals/rounds/1/summary.md',
      'evals/rounds/index.json',
    ]);
    expect(h.out()).toContain(
      'Round 1 recorded in evals/rounds/1/summary.md and evals/ROUNDS.md (decision: pending).',
    );

    const [record] = JSON.parse(h.files['evals/rounds/index.json'] as string) as RoundRecord[];
    expect(record).toMatchObject({
      round: 1,
      date: '2026-11-12T09:00:01.000Z',
      change: 'baseline | ticket format',
      split: 'dev',
      judgeModel: 'claude-sonnet-5-5',
      decision: 'pending',
    });
    expect(record?.promptVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    const variant = outcome.variants?.[0];
    expect(record?.variants).toEqual([
      {
        label: 'claude-opus-5-5 · high',
        runs: DEV.length,
        errors: 0,
        overall: variant?.rubric?.overall,
        scenarioScore: 1.5,
        reportScore: variant?.rubric?.reportScore,
        graded: DEV_GRADED.length,
        passRate: 1,
        alignmentAccuracy: 1,
        findingRecall: 1,
        injectionFlagged: variant?.summary.injectionFlagged,
        scenarioRecall: 1,
        avgTickets: (variant?.runs ?? []).reduce((n, r) => n + r.report.scenarios.length, 0) / DEV.length,
        criteria: variant?.rubric?.criteria,
        costUsd: variant?.costUsd,
        judgeCostUsd: variant?.judgeCostUsd,
      },
    ]);
    expect(record?.variants[0]?.avgTickets).toBeGreaterThan(1);

    const rounds = h.files['evals/ROUNDS.md'] as string;
    expect(rounds).toContain(
      '| Round | Date | Prompt | Change | Split | Rubric | Variant | Overall | Scenario | Report |',
    );
    // The pipe in the change text is escaped so it cannot break the table.
    expect(rounds).toMatch(
      /\n\| 1 \| 2026-11-12 \| \S+ \| baseline \\\| ticket format \| dev \| v2 \| claude-opus-5-5 · high \| \d\.\d\d \| 1\.50 \| \d\.\d\d \| 100% \| 100% \| 100% \| \d\/\d \| \$\d+\.\d\d \| pending \|\n$/,
    );
    const total = (variant?.costUsd ?? 0) + (variant?.judgeCostUsd ?? 0);
    expect(rounds).toContain(`| $${total.toFixed(2)} | pending |`);

    const summary = h.files['evals/rounds/1/summary.md'] as string;
    expect(summary).toMatch(
      /^# Round 1\n\n- Date: 2026-11-12\n- Prompt: `\S+`\n- Change: baseline \| ticket format\n- Split: dev\n- Rubric judge: claude-sonnet-5-5, rubric v2\n- Decision: pending\n/,
    );
    expect(summary).toContain('| Variant | Runs | Errors | Overall |');
    // A blank line before the heading, or Markdown reads it as part of the table above.
    expect(summary).toMatch(/\|\n\n## Compared with the last kept round\n\n/);
    expect(summary).toContain('| Actionability | 1.00 |');
    expect(summary).toContain('| Alignment correctness |');
    expect(summary).toContain(
      '| coupon-expiry-missing | synthetic | 1.50 | 1.50 | 1.50 | pass | partial | — |',
    );
    expect(summary).toContain('| real-demo-1 | real | 1.25 | 1.50 | 1.00 | — | partial | — |');
    // The committed files hold scores only: no report text, no PRD text, no key.
    for (const path of ['evals/ROUNDS.md', 'evals/rounds/1/summary.md', 'evals/rounds/index.json']) {
      expect(h.files[path], path).not.toContain('sk-test');
      expect(h.files[path], path).not.toContain('Oracle summary');
    }
    const raw = JSON.parse(h.files['evals/rounds/1/raw/results.json'] as string) as SavedResults;
    expect(raw.variants[0]?.runs).toHaveLength(DEV.length);
  });

  it('M3.5 the summary shows wrong findings, failures and runs that were not graded', async () => {
    const h = harness({}, (c) => {
      if (c.id === 'search-page-cap') return new TypeError('boom');
      if (c.id !== 'coupon-expiry-missing')
        return oracleReport(graded.find((g) => g.id === c.id) ?? (graded[0] as never));
      const wrong = oracleReport(graded.find((g) => g.id === c.id) as never);
      for (const f of wrong.prdAlignment.findings) f.status = 'covered';
      wrong.prdAlignment.status = 'aligned';
      return wrong;
    });
    await runEvals(
      ['--yes', '--round', '3', '--change', 'no judge', '--cases', 'coupon-expiry-missing,search-page-cap'],
      h.deps,
    );
    const summary = h.files['evals/rounds/3/summary.md'] as string;
    expect(summary).toContain('- Rubric judge: not run');
    expect(summary).toMatch(
      /\| coupon-expiry-missing \| synthetic \| — \| — \| — \| FAIL \| aligned \(expected partial\) \| \S+=covered/,
    );
    expect(summary).toContain('Not graded:\n- search-page-cap: internal');
    expect(summary).not.toContain('| Criterion |');
    expect(h.files['evals/ROUNDS.md']).toMatch(
      /\| 3 \| .* \| selected \| — \| claude-opus-5-5 · high \| — \| — \| — \| 0% \| 0% \|/,
    );
  });

  it('M3.5 rounds accumulate in order, a re-run replaces its own row, and --decision records keep or revert', async () => {
    const first = harness();
    await runEvals(['--yes', '--judge', '--round', '2', '--change', 'second idea'], first.deps);
    const shared = { writeFile: first.deps.writeFile, readFile: first.deps.readFile };
    await runEvals(['--yes', '--judge', '--round', '1', '--change', 'baseline'], harness(shared).deps);
    const rows = (): string[] =>
      (first.files['evals/ROUNDS.md'] as string).split('\n').filter((l) => /^\| \d/.test(l));
    expect(rows().map((r) => r.split(' | ').slice(0, 4).join(' | '))).toEqual([
      expect.stringMatching(/^\| 1 \| 2026-11-12 \| \S+ \| baseline$/),
      expect.stringMatching(/^\| 2 \| 2026-11-12 \| \S+ \| second idea$/),
    ]);

    await runEvals(
      ['--yes', '--judge', '--round', '2', '--change', 'second idea, again'],
      harness(shared).deps,
    );
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toContain('second idea, again');

    const decide = offline(first);
    expect(await runEvals(['--round', '2', '--decision', 'revert'], decide.deps)).toMatchObject({
      exitCode: 0,
      executed: false,
    });
    expect(await runEvals(['--round', '1', '--decision', 'keep'], offline(first).deps)).toMatchObject({
      exitCode: 0,
    });
    expect(rows().map((r) => r.split(' | ').at(-1))).toEqual(['keep |', 'revert |']);
    expect(decide.out()).toBe('Round 2: revert. evals/ROUNDS.md updated.');
    const index = JSON.parse(first.files['evals/rounds/index.json'] as string) as RoundRecord[];
    expect(index.map((r) => [r.round, r.decision])).toEqual([
      [1, 'keep'],
      [2, 'revert'],
    ]);
    // A decision changes nothing else: no new results, no summary rewrite.
    expect(
      Object.keys(first.files)
        .filter((f) => f.includes('/raw/'))
        .sort(),
    ).toEqual(['evals/rounds/1/raw/results.json', 'evals/rounds/2/raw/results.json']);

    const unknown = offline(first);
    expect(await runEvals(['--round', '7', '--decision', 'keep'], unknown.deps)).toMatchObject({
      exitCode: 2,
    });
    expect(unknown.out()).toBe('Round 7 has not been recorded yet.');
  });

  it('M3.5 without --yes a round records nothing', async () => {
    const h = harness();
    expect(await runEvals(['--judge', '--round', '1', '--change', 'baseline'], h.deps)).toMatchObject({
      executed: false,
    });
    expect(h.files).toEqual({});
    expect(renderRoundsIndex([])).toMatch(/\| Round \| Date \|.*\n\| --- \|.*\n$/);
  });
});

describe('round 0 and the keep/revert recommendation (M3.5, RUBRIC.md "Scoring")', () => {
  const variant = (overrides: Partial<RoundVariant> = {}): RoundVariant => ({
    label: 'claude-opus-5-5 · high',
    runs: 19,
    errors: 0,
    overall: 1.4,
    scenarioScore: 1.3,
    reportScore: 1.5,
    graded: 15,
    passRate: 0.8,
    alignmentAccuracy: 0.8,
    findingRecall: 0.9,
    injectionFlagged: '1/2',
    scenarioRecall: 1,
    avgTickets: 13.3,
    costUsd: 4,
    judgeCostUsd: 1,
    ...overrides,
  });
  const round = (
    n: number,
    decision: RoundRecord['decision'],
    v: Partial<RoundVariant> = {},
    overrides: Partial<RoundRecord> = {},
  ): RoundRecord => ({
    round: n,
    date: '2026-11-12T09:00:00.000Z',
    promptVersion: '2026-11-12.3',
    change: `change ${n}`,
    split: 'dev',
    judgeModel: 'claude-sonnet-5-5',
    variants: [variant(v)],
    decision,
    ...overrides,
  });
  const advise = (current: RoundRecord, earlier: RoundRecord[]) => compareWithLastKept(current, earlier);

  it('M3.5 --round accepts 0 for the baseline, for a run and for a decision', async () => {
    expect(parseArgs(['--round', '0', '--change', 'baseline'], { model: 'm', effort: 'high' }).round).toBe(0);
    expect(parseArgs(['--round', '0', '--decision', 'keep'], { model: 'm', effort: 'high' })).toMatchObject({
      round: 0,
      decision: 'keep',
    });

    const h = harness();
    const outcome = await runEvals(['--yes', '--judge', '--round', '0', '--change', 'baseline'], h.deps);
    expect(outcome).toMatchObject({ exitCode: 0, executed: true });
    expect(Object.keys(h.files).sort()).toEqual([
      'evals/ROUNDS.md',
      'evals/rounds/0/raw/results.json',
      'evals/rounds/0/summary.md',
      'evals/rounds/index.json',
    ]);
    expect(h.files['evals/ROUNDS.md']).toMatch(/\n\| 0 \| 2026-11-12 \| \S+ \| baseline \| dev \| v2 \|/);
    const advice =
      'No recommendation for round 0: Round 0 is the baseline. Mark it with --round 0 --decision keep so later rounds are compared with it.';
    expect(h.lines.at(-1)).toBe(advice);
    expect(h.files['evals/rounds/0/summary.md']).toContain(
      `## Compared with the last kept round\n\n${advice}\n`,
    );

    const decide = offline(h);
    expect(await runEvals(['--round', '0', '--decision', 'keep'], decide.deps)).toMatchObject({
      exitCode: 0,
    });
    expect(decide.out()).toBe('Round 0: keep. evals/ROUNDS.md updated.');
    expect(h.files['evals/ROUNDS.md']).toMatch(/\n\| 0 \|.*\| keep \|\n$/);
  });

  it('M3.5 a recorded round is compared with the last kept one and gets a recommendation', async () => {
    const base = harness();
    await runEvals(['--yes', '--judge', '--round', '0', '--change', 'baseline'], base.deps);
    const shared = { writeFile: base.deps.writeFile, readFile: base.deps.readFile };

    // Before round 0 has a decision there is nothing to compare with.
    const early = harness(shared);
    await runEvals(['--yes', '--judge', '--round', '1', '--change', 'same output'], early.deps);
    expect(early.lines.at(-1)).toBe(
      'No recommendation for round 1: No earlier round is marked keep, so there is nothing to compare with.',
    );
    await runEvals(['--round', '0', '--decision', 'keep'], offline(base).deps);

    // Same reports, same judge: the overall did not rise.
    const same = harness(shared);
    await runEvals(['--yes', '--judge', '--round', '1', '--change', 'same output'], same.deps);
    expect(same.out()).toContain('Compared with round 0 (the last one kept):');
    expect(same.out()).toContain('| Variant | Metric | Round 0 | Round 1 | Change |');
    expect(same.out()).toMatch(/\| claude-opus-5-5 · high \| Overall \| (\d\.\d\d) \| \1 \| 0 \|/);
    expect(same.out()).toContain('| claude-opus-5-5 · high | Alignment | 100% | 100% | 0 |');
    expect(same.out()).toContain(
      'Recommendation for round 1: REVERT. The dev overall did not rise. Record the decision with --round 1 --decision keep|revert.',
    );
    expect(base.files['evals/rounds/1/summary.md']).toContain('Recommendation for round 1: REVERT.');
    // The recommendation is advice only: the recorded decision stays pending.
    expect(base.files['evals/ROUNDS.md']).toMatch(/\n\| 1 \|.*\| pending \|\n$/);

    // A judge that scores the real-PR report higher lifts the overall; nothing deterministic moved.
    const better = harness({ ...shared, createRubricClient: () => fakeRubricClient(2) });
    await runEvals(['--yes', '--judge', '--round', '2', '--change', 'better'], better.deps);
    expect(better.out()).toMatch(
      /\| claude-opus-5-5 · high \| Overall \| \d\.\d\d \| \d\.\d\d \| \+0\.\d\d \|/,
    );
    expect(better.out()).toContain(
      'Recommendation for round 2: KEEP. The dev overall rose and no deterministic metric fell.',
    );

    // Higher overall, but one case now gets its findings wrong: revert.
    const worse = harness({ ...shared, createRubricClient: () => fakeRubricClient(2) }, (c) => {
      const report = oracleReport(
        graded.find((g) => g.id === c.id) ?? (graded[0] as (typeof graded)[number]),
      );
      if (c.id !== 'coupon-expiry-missing') return report;
      for (const f of report.prdAlignment.findings) f.status = 'covered';
      report.prdAlignment.status = 'aligned';
      return report;
    });
    await runEvals(['--yes', '--judge', '--round', '3', '--change', 'regression'], worse.deps);
    expect(worse.out()).toMatch(/\| Alignment \| 100% \| \d\d% \| −\d+ pt \|/);
    expect(worse.out()).toContain(
      'Recommendation for round 3: REVERT. A deterministic metric fell: alignment, findings.',
    );
  });

  it('M3.5 the baseline is the latest earlier round marked keep; pending and reverted rounds are skipped', () => {
    const earlier = [
      round(0, 'keep', { overall: 1.0 }),
      round(1, 'keep', { overall: 1.4 }),
      round(2, 'revert', { overall: 1.9 }),
      round(3, 'pending', { overall: 1.9 }),
      round(9, 'keep', { overall: 0.1 }), // a later round is never the baseline
    ];
    const result = advise(round(4, 'pending', { overall: 1.5 }), earlier);
    expect(result).toMatchObject({ baseline: 1, recommendation: 'keep' });
    expect(result.rows.map((r) => [r.metric, r.before, r.after, r.change, r.context])).toEqual([
      ['Overall', 1.4, 1.5, 'up', false],
      ['Alignment', 0.8, 0.8, 'same', false],
      ['Findings', 0.9, 0.9, 'same', false],
      ['Injection', 0.5, 0.5, 'same', false],
      ['Pass', 0.8, 0.8, 'same', true],
      ['Scenarios (kw)', 1, 1, 'same', true],
      ['Tickets per report', 13.3, 13.3, 'same', true],
    ]);
    expect(advise(round(4, 'pending', { overall: 1.3 }), earlier)).toMatchObject({
      baseline: 1,
      recommendation: 'revert',
      reason: 'The dev overall did not rise.',
    });
    expect(advise(round(4, 'pending'), [round(2, 'revert'), round(3, 'pending')])).toMatchObject({
      baseline: null,
      recommendation: 'none',
    });
  });

  it('M3.5 any deterministic metric that falls means revert, however much the overall rose', () => {
    const kept = [round(0, 'keep')];
    for (const [fall, name] of [
      [{ alignmentAccuracy: 0.79 }, 'alignment'],
      [{ findingRecall: 0.5 }, 'findings'],
      [{ injectionFlagged: '0/2' }, 'injection'],
    ] as const) {
      expect(advise(round(1, 'pending', { overall: 2, ...fall }), kept), name).toMatchObject({
        recommendation: 'revert',
        reason: `A deterministic metric fell: ${name}.`,
      });
    }
    // Rising deterministic metrics are fine; the pass rate is not one of the three named metrics.
    expect(
      advise(
        round(1, 'pending', { overall: 1.5, alignmentAccuracy: 1, injectionFlagged: '2/2', passRate: 0.1 }),
        kept,
      ),
    ).toMatchObject({ recommendation: 'keep' });
    // Float noise is not a fall.
    expect(
      advise(round(1, 'pending', { overall: 1.5, findingRecall: 0.9 - 1e-12 }), kept).recommendation,
    ).toBe('keep');
  });

  it('M3.5 context rows never change the recommendation, but a fall in pass rate or coverage is called out', () => {
    const kept = [round(0, 'keep')];
    // Fewer tickets with the same coverage: nothing to note.
    const leaner = advise(round(1, 'pending', { overall: 1.6, avgTickets: 7.5 }), kept);
    expect(leaner).toMatchObject({
      recommendation: 'keep',
      reason: 'The dev overall rose and no deterministic metric fell.',
    });
    expect(leaner.rows.find((r) => r.metric === 'Tickets per report')).toMatchObject({
      before: 13.3,
      after: 7.5,
      change: 'down',
      context: true,
    });
    expect(formatComparison(1, leaner)).toContain(
      '| claude-opus-5-5 · high | Tickets per report (context) | 13.3 | 7.5 | −5.8 |',
    );

    // The overall rose, so the rule says keep, but cutting tickets cost coverage and passes.
    const thinner = advise(
      round(1, 'pending', { overall: 1.6, avgTickets: 6, scenarioRecall: 0.7, passRate: 0.6 }),
      kept,
    );
    expect(thinner).toMatchObject({
      recommendation: 'keep',
      reason:
        'The dev overall rose and no deterministic metric fell. Note: Pass and Scenarios (kw) fell. That is outside the rule, so look at it before deciding.',
    });
    expect(formatComparison(1, thinner)).toContain(
      '| claude-opus-5-5 · high | Scenarios (kw) (context) | 100% | 70% | −30 pt |',
    );
    expect(advise(round(1, 'pending', { overall: 1.2, scenarioRecall: 0.7 }), kept).reason).toBe(
      'The dev overall did not rise. Note: Scenarios (kw) fell. That is outside the rule, so look at it before deciding.',
    );

    // A record written before these values were stored shows "—" and is not treated as a fall.
    const old = [round(0, 'keep', { scenarioRecall: undefined, avgTickets: undefined })];
    const first = advise(round(1, 'pending', { overall: 1.6, avgTickets: 7.5 }), old);
    expect(first.reason).toBe('The dev overall rose and no deterministic metric fell.');
    expect(formatComparison(1, first)).toContain(
      '| claude-opus-5-5 · high | Tickets per report (context) | — | 7.5 | — |',
    );
  });

  it('M3.5 gives no recommendation when the rounds cannot be compared, and says why', () => {
    const kept = [round(0, 'keep')];
    expect(advise(round(1, 'pending', { overall: null }), kept)).toMatchObject({
      recommendation: 'none',
      reason:
        'One of the two rounds has no rubric score (run with --judge), so the overall cannot be compared.',
    });
    expect(advise(round(1, 'pending', {}, { split: 'test' }), kept)).toMatchObject({
      baseline: 0,
      rows: [],
      recommendation: 'none',
      reason: 'Round 0 ran the "dev" split and this round ran "test", so the scores are not comparable.',
    });
    expect(advise(round(1, 'pending', { label: 'claude-opus-5-5 · medium' }), kept)).toMatchObject({
      recommendation: 'none',
      reason: 'Round 0 has no variant with the same model and effort.',
    });
    // A round with no graded case or no injection case shows "—" there and is not penalised for it.
    const judgeOnly = advise(round(1, 'pending', { overall: 1.6, graded: 0, injectionFlagged: '0/0' }), kept);
    expect(judgeOnly.recommendation).toBe('keep');
    expect(judgeOnly.rows.filter((r) => r.change === 'n/a').map((r) => r.metric)).toEqual([
      'Alignment',
      'Findings',
      'Injection',
      'Pass',
    ]);
    expect(formatComparison(1, judgeOnly)).toEqual([
      'Compared with round 0 (the last one kept):',
      '',
      '| Variant | Metric | Round 0 | Round 1 | Change |',
      '| --- | --- | --- | --- | --- |',
      '| claude-opus-5-5 · high | Overall | 1.40 | 1.60 | +0.20 |',
      '| claude-opus-5-5 · high | Alignment | — | — | — |',
      '| claude-opus-5-5 · high | Findings | — | — | — |',
      '| claude-opus-5-5 · high | Injection | 50% | — | — |',
      '| claude-opus-5-5 · high | Pass (context) | — | — | — |',
      '| claude-opus-5-5 · high | Scenarios (kw) (context) | 100% | 100% | 0 |',
      '| claude-opus-5-5 · high | Tickets per report (context) | 13.3 | 13.3 | 0 |',
      '',
      'Rows marked "context" do not affect the recommendation.',
      '',
      'Recommendation for round 1: KEEP. The dev overall rose and no deterministic metric fell. Record the decision with --round 1 --decision keep|revert.',
    ]);
  });
});

/** A judged dev run plus the path of its results file. */
async function judgedRun(): Promise<{ h: Harness; path: string; saved: SavedResults }> {
  const h = harness();
  const outcome = await runEvals(['--yes', '--judge', '--split', 'all'], h.deps);
  const path = Object.keys(h.files)[0] as string;
  expect(outcome.exitCode).toBe(0);
  return { h, path, saved: JSON.parse(h.files[path] as string) as SavedResults };
}

describe('review pack (M3.5)', () => {
  it('M3.5 --review-pack writes a blind pack: case, PRD, change summary, rendered ticket and empty rating slots', async () => {
    const { h, path } = await judgedRun();
    const o = offline(h);
    const outcome = await runEvals(
      ['--review-pack', path, '--sample', '5', '--out', 'evals/results/pack.json'],
      o.deps,
    );
    expect(outcome).toMatchObject({ exitCode: 0, executed: false, estimateUsd: 0 });
    expect(o.out()).toBe(
      'Review pack with 5 report(s) from "claude-opus-5-5 · high" written to evals/results/pack.json. It holds no judge scores and no expected answers.',
    );

    const pack = JSON.parse(h.files['evals/results/pack.json'] as string) as ReviewPack;
    expect(pack).toMatchObject({ version: 1, source: path, variant: 'claude-opus-5-5 · high' });
    expect(Object.keys(pack.rubric)).toEqual([
      'actionability',
      'traceability',
      'riskRelevance',
      'priority',
      'alignmentCorrectness',
      'concision',
      'honesty',
      'coverage',
    ]);
    expect(pack.rubric.actionability).toMatchObject({ name: 'Actionability', level: 'scenario' });
    expect(pack.rubric.honesty.level).toBe('report');
    expect(pack.rubric.priority.anchors).toHaveLength(3);
    expect(pack.samples).toHaveLength(5);
    expect(new Set(pack.samples.map((s) => s.sampleId)).size).toBe(5);

    for (const sample of pack.samples) {
      const evalCase = dataset.find((c) => c.id === sample.caseId);
      expect(sample.sampleId).toBe(`${sample.caseId}#1`);
      expect(sample.change.title).toBe(evalCase?.pr.title);
      expect(sample.change.files.map((f) => f.path)).toEqual(evalCase?.files.map((f) => f.path));
      expect(sample.change.hunks.length).toBeGreaterThanOrEqual(1);
      expect(sample.change.hunks.length).toBeLessThanOrEqual(3);
      for (const hunk of sample.change.hunks) expect(hunk.text.split('\n').length).toBeLessThanOrEqual(40);
      expect(sample.prd.map((p) => p.title)).toEqual(evalCase?.prdDocuments.map((d) => d.title));
      expect(sample.ticketMarkdown).toContain('## 🧪 AI QA —');
      expect(sample.ticketMarkdown).toContain('TC-01');
      expect(sample.ratings.scenarios.length).toBeGreaterThan(0);
      for (const s of sample.ratings.scenarios) {
        expect(s.scores).toEqual({
          actionability: null,
          traceability: null,
          riskRelevance: null,
          priority: null,
        });
      }
      expect(sample.ratings.report).toEqual({
        alignmentCorrectness: null,
        concision: null,
        honesty: null,
        coverage: null,
      });
      expect(sample.ratings.notes).toBe('');
    }
    const coupon =
      pack.samples.find((s) => s.caseId === 'coupon-expiry-missing') ??
      pack.samples.find((s) => s.prd.length > 0);
    expect(coupon?.prd[0]?.acceptanceCriteria.length).toBeGreaterThan(0);

    // Blind: nothing the judge said and none of the expected answers.
    const text = h.files['evals/results/pack.json'] as string;
    for (const leak of [
      'cites the AC and the file',
      'one status looks wrong',
      'mustFindings',
      'judgedAlignment',
      '"overall"',
      '"grade"',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
    for (const c of graded) expect(text, c.id).not.toContain(c.expected.notes);
  });

  it('M3.5 samples are chosen the same way every time, spread across the judge score range', async () => {
    const run = (caseId: string, overall?: number): RunRecord =>
      ({ caseId, rep: 0, rubric: overall === undefined ? undefined : { overall } }) as RunRecord;
    const judged = [
      run('e', 1.9),
      run('a', 0.2),
      run('c', 1.0),
      run('b', 0.6),
      run('d', 1.4),
      run('f', 2),
      run('g', 1.2),
    ];
    const picked = pickSamples(judged, 3).map((r) => r.caseId);
    expect(picked).toEqual(['a', 'g', 'f']); // lowest, middle, highest
    expect(pickSamples([...judged].reverse(), 3).map((r) => r.caseId)).toEqual(picked);
    expect(pickSamples(judged, 20)).toHaveLength(7);
    expect(pickSamples(judged, 1).map((r) => r.caseId)).toEqual(['a']);
    // Without judge scores the spread is over case ids.
    expect(pickSamples([run('z'), run('m'), run('a'), run('q'), run('c')], 3).map((r) => r.caseId)).toEqual([
      'a',
      'm',
      'z',
    ]);
  });

  it('M3.5 defaults to 5 samples in the results directory, and explains unusable input with exit code 2', async () => {
    const { h, path } = await judgedRun();
    const o = offline(h);
    await runEvals(['--review-pack', path], o.deps);
    const out = Object.keys(h.files).find((f) => f.endsWith('review-pack.json')) as string;
    expect(out.replace(/\\/g, '/')).toBe('evals/results/review-pack.json');
    expect((JSON.parse(h.files[out] as string) as ReviewPack).samples).toHaveLength(5);

    const missing = offline(h);
    expect(await runEvals(['--review-pack', 'nope.json'], missing.deps)).toMatchObject({ exitCode: 2 });
    expect(missing.out()).toBe('Cannot build a review pack: nope.json is not a readable eval results file.');

    // A results file from before runs stored the rendered comment has nothing to show a reviewer.
    const old = harness();
    old.files['old.json'] = JSON.stringify({
      variants: [
        {
          label: 'v',
          runs: [{ caseId: 'coupon-expiry-missing', rep: 0, report: nullReport('aligned') }],
          errors: [],
        },
      ],
    });
    expect(await runEvals(['--review-pack', 'old.json'], old.deps)).toMatchObject({ exitCode: 2 });
    expect(old.out()).toBe(
      'Cannot build a review pack: the results file has no rendered reports for the current cases.',
    );
  });
});

describe('judge calibration (M3.5, RUBRIC.md "Judge calibration")', () => {
  /** Builds a pack and fills every slot with `rate`. The judge double scored scenarios 1/2/1/2 and the report 0/1/2. */
  async function ratedPack(
    rate: (criterion: string) => number | null,
  ): Promise<{ h: Harness; path: string; pack: ReviewPack; saved: SavedResults }> {
    const { h, path, saved } = await judgedRun();
    await runEvals(['--review-pack', path, '--sample', '4', '--out', 'pack.json'], offline(h).deps);
    const pack = JSON.parse(h.files['pack.json'] as string) as ReviewPack;
    for (const sample of pack.samples) {
      for (const s of sample.ratings.scenarios) {
        for (const c of Object.keys(s.scores) as (keyof typeof s.scores)[]) s.scores[c] = rate(c);
      }
      for (const c of Object.keys(sample.ratings.report) as (keyof typeof sample.ratings.report)[]) {
        sample.ratings.report[c] = rate(c);
      }
    }
    h.files['ratings.json'] = JSON.stringify(pack);
    return { h, path, pack, saved };
  }

  it('M3.5 --calibrate prints the mean difference per criterion and passes a judge that agrees', async () => {
    const agree: Record<string, number> = {
      actionability: 1,
      traceability: 2,
      riskRelevance: 1,
      priority: 2,
      alignmentCorrectness: 0,
      concision: 1,
      honesty: 2,
      coverage: 1,
    };
    const { h, path, pack, saved } = await ratedPack((c) => agree[c] ?? null);
    const o = offline(h);
    expect(await runEvals(['--calibrate', 'ratings.json', path], o.deps)).toMatchObject({
      exitCode: 0,
      executed: false,
    });

    const scenarios = pack.samples.reduce((n, s) => n + s.ratings.scenarios.length, 0);
    expect(o.lines[0]).toBe('Calibration of the rubric judge against ratings.json (scores 0–2)');
    expect(o.out()).toContain('| Criterion | Pairs | Human | Judge | Judge − human | Mean abs. diff |');
    expect(o.out()).toContain(`| Actionability | ${scenarios} | 1.00 | 1.00 | 0.00 | 0.00 |`);
    expect(o.out()).toContain(`| Traceability | ${scenarios} | 2.00 | 2.00 | 0.00 | 0.00 |`);
    // Alignment is compared with what the judge itself said (0), not with the ground-truth override (2).
    expect(o.out()).toContain('| Alignment correctness | 4 | 0.00 | 0.00 | 0.00 | 0.00 |');
    expect(o.out()).toContain('Mean absolute difference across criteria: 0.00 (limit 0.5).');
    expect(o.lines.at(-1)).toBe('The judge is within the limit on every rated criterion.');
    expect(compareRatings(pack, saved).every((r) => r.meanAbsDiff === 0)).toBe(true);
    expect(CALIBRATION_LIMIT).toBe(0.5);
  });

  it('M3.5 flags the criteria where the judge is off by more than 0.5, with the direction', async () => {
    // The reviewer is stricter on actionability (0 vs 1) and more generous on concision (2 vs 1).
    const strict: Record<string, number> = {
      actionability: 0,
      traceability: 2,
      riskRelevance: 1,
      priority: 2,
      alignmentCorrectness: 0,
      concision: 2,
      honesty: 2,
      coverage: 1,
    };
    const { h, path, pack, saved } = await ratedPack((c) => strict[c] ?? null);
    const o = offline(h);
    await runEvals(['--calibrate', 'ratings.json', path], o.deps);

    expect(o.out()).toMatch(/\| Actionability \| \d+ \| 0\.00 \| 1\.00 \| \+1\.00 \| 1\.00 \|/);
    expect(o.out()).toContain('| Concision | 4 | 2.00 | 1.00 | -1.00 | 1.00 |');
    expect(o.out()).toContain('Mean absolute difference across criteria: 0.25 (limit 0.5).');
    expect(o.lines.at(-1)).toBe(
      'The judge disagrees with the ratings on: Actionability, Concision. Refine the judge prompt or the rubric before trusting its scores.',
    );
    const rows = compareRatings(pack, saved);
    expect(rows.find((r) => r.criterion === 'actionability')).toMatchObject({
      human: 0,
      judge: 1,
      meanDiff: 1,
      meanAbsDiff: 1,
    });
    // Opposite errors must not cancel out: the absolute difference is what is checked.
    expect(rows.find((r) => r.criterion === 'concision')).toMatchObject({ meanDiff: -1, meanAbsDiff: 1 });
  });

  it('M3.5 slots left empty are skipped, and a pack that matches nothing is an error', async () => {
    const { h, path } = await ratedPack((c) => (c === 'honesty' ? 1 : null));
    const o = offline(h);
    expect(await runEvals(['--calibrate', 'ratings.json', path], o.deps)).toMatchObject({ exitCode: 0 });
    expect(o.out()).toContain('| Actionability | 0 | — | — | — | — |');
    expect(o.out()).toContain('| Honesty | 4 | 1.00 | 2.00 | +1.00 | 1.00 |');
    expect(o.lines.at(-1)).toMatch(/^The judge disagrees with the ratings on: Honesty\./);

    const blank = await ratedPack(() => null);
    const none = offline(blank.h);
    expect(await runEvals(['--calibrate', 'ratings.json', blank.path], none.deps)).toMatchObject({
      exitCode: 2,
    });
    expect(none.out()).toBe(
      'Cannot calibrate: no rating in the pack matches a judged report in the results file.',
    );

    const bad = offline(h);
    expect(await runEvals(['--calibrate', 'nope.json', path], bad.deps)).toMatchObject({ exitCode: 2 });
    expect(bad.out()).toBe('Cannot calibrate: nope.json is not a readable review pack.');
    const badResults = offline(h);
    expect(await runEvals(['--calibrate', 'ratings.json', 'nope.json'], badResults.deps)).toMatchObject({
      exitCode: 2,
    });
    expect(badResults.out()).toBe('Cannot calibrate: nope.json is not a readable eval results file.');
  });
});
