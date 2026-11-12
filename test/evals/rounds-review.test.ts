import { describe, expect, it } from 'vitest';
import { CALIBRATION_LIMIT, compareRatings, pickSamples, type ReviewPack } from '../../evals/review';
import { type RoundRecord, renderRoundsIndex } from '../../evals/rounds';
import { type RunRecord, runEvals, type SavedResults } from '../../evals/run';
import { DEV, DEV_GRADED, dataset, graded, harness } from './harness';
import { nullReport, oracleReport } from './support';

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
        costUsd: variant?.costUsd,
        judgeCostUsd: variant?.judgeCostUsd,
      },
    ]);

    const rounds = h.files['evals/ROUNDS.md'] as string;
    expect(rounds).toContain(
      '| Round | Date | Prompt | Change | Split | Variant | Overall | Scenario | Report |',
    );
    // The pipe in the change text is escaped so it cannot break the table.
    expect(rounds).toMatch(
      /\n\| 1 \| 2026-11-12 \| \S+ \| baseline \\\| ticket format \| dev \| claude-opus-5-5 · high \| \d\.\d\d \| 1\.50 \| \d\.\d\d \| 100% \| 100% \| 100% \| \d\/\d \| \$\d+\.\d\d \| pending \|\n$/,
    );
    const total = (variant?.costUsd ?? 0) + (variant?.judgeCostUsd ?? 0);
    expect(rounds).toContain(`| $${total.toFixed(2)} | pending |`);

    const summary = h.files['evals/rounds/1/summary.md'] as string;
    expect(summary).toMatch(
      /^# Round 1\n\n- Date: 2026-11-12\n- Prompt: `\S+`\n- Change: baseline \| ticket format\n- Split: dev\n- Rubric judge: claude-sonnet-5-5\n- Decision: pending\n/,
    );
    expect(summary).toContain('| Variant | Runs | Errors | Overall |');
    expect(summary).toContain('| Actionability | 1.00 |');
    expect(summary).toContain('| Alignment correctness |');
    expect(summary).toContain(
      '| coupon-expiry-missing | synthetic | 1.58 | 1.50 | 1.67 | pass | partial | — |',
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
    expect(h.files['evals/ROUNDS.md']).toMatch(/\| 3 \| .* \| selected \| .* \| — \| — \| — \| 0% \| 0% \|/);
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
      expect(sample.ratings.report).toEqual({ alignmentCorrectness: null, concision: null, honesty: null });
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
    };
    const { h, path, pack, saved } = await ratedPack((c) => strict[c] ?? null);
    const o = offline(h);
    await runEvals(['--calibrate', 'ratings.json', path], o.deps);

    expect(o.out()).toMatch(/\| Actionability \| \d+ \| 0\.00 \| 1\.00 \| \+1\.00 \| 1\.00 \|/);
    expect(o.out()).toContain('| Concision | 4 | 2.00 | 1.00 | -1.00 | 1.00 |');
    expect(o.out()).toContain('Mean absolute difference across criteria: 0.29 (limit 0.5).');
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
