import { describe, expect, it, vi } from 'vitest';
import { JUDGE_MODEL, type JudgeClientLike, judgeScenarios } from '../../evals/judge';
import { DEFAULT_RUBRIC_MODEL, type RubricClientLike } from '../../evals/rubric';
import { PRODUCTION, parseArgs, type RunDeps, runEvals, type SavedResults, USAGE } from '../../evals/run';
import { type EvalCase, type GradedCase, loadDataset } from '../../evals/schema';
import type {
  CreatePreprocessEngine,
  GenerateRequest,
  LlmProvider,
  QaReport,
} from '../../src/core/contracts';
import { QtgError } from '../../src/core/errors';
import { estimateCostUsd } from '../../src/llm/pricing';
import {
  fakeEngine,
  fakeRubricClient,
  gradedCases,
  makeEvalsRoot,
  nullReport,
  oracleReport,
  REAL_ABSENT,
  REAL_DEMO,
  RUBRIC_USAGE,
  type RubricBody,
} from './support';

const EVALS = makeEvalsRoot();
const dataset = loadDataset(EVALS).cases;
const graded = gradedCases();
const byPr = new Map(dataset.map((c) => [c.pr.number, c]));
const caseFor = (req: GenerateRequest): EvalCase => byPr.get(req.context.pr.number) as EvalCase;
/** The synthetic case a case's content comes from (itself, or the source of a real-PR stand-in). */
const sourceOf = (c: EvalCase): GradedCase => {
  const source = (REAL_DEMO as Record<string, { source: string }>)[c.id]?.source ?? c.id;
  return graded.find((g) => g.id === source) as GradedCase;
};
const inSplit = (split: 'dev' | 'test'): EvalCase[] => dataset.filter((c) => c.split === split);
const DEV = inSplit('dev');
const DEV_GRADED = DEV.filter((c) => c.expected !== null);
const USAGE_PER_CALL = { inputTokens: 4_000, outputTokens: 6_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
const RUBRIC_COST = estimateCostUsd(DEFAULT_RUBRIC_MODEL, {
  inputTokens: RUBRIC_USAGE.input_tokens,
  outputTokens: RUBRIC_USAGE.output_tokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Provider double: answers every case with its oracle report unless `respond` says otherwise. */
function fakeProvider(
  model: string,
  respond?: (c: EvalCase) => QaReport | Error,
  servedModel = model,
): LlmProvider {
  return {
    id: 'fake',
    async generateReport(req) {
      const c = caseFor(req);
      const answer = respond ? respond(c) : oracleReport(sourceOf(c));
      if (answer instanceof Error) throw answer;
      return { value: answer, usage: USAGE_PER_CALL, model: servedModel, stopReason: 'end_turn' };
    },
    async mergeReports() {
      throw new Error('not used: every eval case fits one call');
    },
    estimateCostUsd: (usage) => estimateCostUsd(model, usage),
  };
}

function harness(overrides: Partial<RunDeps> = {}, respond?: (c: EvalCase) => QaReport | Error) {
  const lines: string[] = [];
  const files: Record<string, string> = {};
  const rubricBodies: RubricBody[] = [];
  const norm = (path: string): string => path.replace(/\\/g, '/').replace(EVALS.replace(/\\/g, '/'), 'evals');
  let clock = Date.UTC(2026, 10, 12, 9, 0, 0);
  const createProvider = vi.fn((request: { model: string }) => fakeProvider(request.model, respond));
  const createJudgeClient = vi.fn(
    (): JudgeClientLike => ({
      messages: {
        parse: async () => ({
          parsed_output: { verdicts: [{ id: 'expired', covered: true, scenarioId: 'TC-01' }] },
          usage: { input_tokens: 3_000, output_tokens: 400 },
        }),
      },
    }),
  );
  const createRubricClient = vi.fn((): RubricClientLike => fakeRubricClient(0, rubricBodies));
  const deps: RunDeps = {
    evalsRoot: EVALS,
    resultsRoot: 'evals/results',
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    print: (line) => void lines.push(line),
    now: () => {
      clock += 1_000;
      return clock;
    },
    createEngine: fakeEngine,
    createProvider,
    createJudgeClient,
    createRubricClient,
    writeFile: (path, text) => {
      files[norm(path)] = text;
    },
    readFile: (path) => {
      const text = files[norm(path)];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    ...overrides,
  };
  return {
    deps,
    lines,
    files,
    rubricBodies,
    createProvider,
    createJudgeClient,
    createRubricClient,
    out: () => lines.join('\n'),
  };
}

describe('runEvals — cost confirmation gate', () => {
  it('SPEC §12.3 without --yes it prints the plan with run and judge cost apart, and creates no client', async () => {
    const h = harness();
    const outcome = await runEvals(['--effort', 'high,medium', '--judge'], h.deps);

    expect(outcome).toMatchObject({ exitCode: 0, executed: false });
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.createJudgeClient).not.toHaveBeenCalled();
    expect(h.createRubricClient).not.toHaveBeenCalled();
    expect(h.files).toEqual({});
    expect(h.out()).toContain('model: claude-opus-5-5   effort: high, medium   reps: 1');
    expect(h.out()).toContain(`split: dev   cases: ${DEV.length} (${DEV_GRADED.length} with ground truth)`);
    expect(h.out()).toContain(`runs: ${DEV.length} per variant × 2 variant(s)`);
    expect(h.out()).toMatch(/estimated run cost: {3}~\$\d+\.\d\d \(claude-opus-5-5\)/);
    expect(h.out()).toMatch(/estimated judge cost: ~\$\d+\.\d\d \(claude-sonnet-5-5 rubric judge\)/);
    expect(h.out()).toMatch(/estimated total: {6}~\$\d+\.\d\d/);
    expect(h.lines.at(-1)).toBe('Nothing was sent to the API. Re-run with --yes to execute.');
    // Small single-call cases at the guard's 12K-output assumption on Opus 5.5: about $0.25 each.
    const perRun = (outcome.estimate?.runUsd ?? 0) / (DEV.length * 2);
    expect(perRun).toBeGreaterThan(0.2);
    expect(perRun).toBeLessThan(0.3);
    // The rubric judge on Sonnet 5.5 reads the case and writes ~5K tokens: several cents per report.
    const perJudge = (outcome.estimate?.judgeUsd ?? 0) / (DEV.length * 2);
    expect(perJudge).toBeGreaterThan(0.05);
    expect(perJudge).toBeLessThan(0.12);
    expect(outcome.estimateUsd).toBeCloseTo(
      (outcome.estimate?.runUsd ?? 0) + (outcome.estimate?.judgeUsd ?? 0),
      9,
    );
    expect(PRODUCTION).toEqual({ expectedOutputTokens: 12_000, mapConcurrency: 3, maxOutputTokens: 32_000 });
  });

  it('the estimate scales with reps and variants, and each judge adds its own cost', async () => {
    const one = await runEvals(['--cases', 'report-timezone'], harness().deps);
    expect(one.estimate?.judgeUsd).toBe(0);
    const plain = harness();
    await runEvals(['--cases', 'report-timezone'], plain.deps);
    expect(plain.out()).toContain('estimated judge cost: ~$0.00 (no judge; add --judge for rubric scores)');

    const many = await runEvals(
      ['--cases', 'report-timezone', '--reps', '3', '--effort', 'high,medium'],
      harness().deps,
    );
    expect(many.estimateUsd).toBeCloseTo(one.estimateUsd * 6, 6);

    const rubric = await runEvals(['--cases', 'report-timezone', '--judge'], harness().deps);
    expect(rubric.estimate?.runUsd).toBeCloseTo(one.estimateUsd, 9);
    expect(rubric.estimate?.judgeUsd).toBeGreaterThan(0);
    const cheaper = await runEvals(
      ['--cases', 'report-timezone', '--judge', '--judge-model', 'claude-haiku-5-5'],
      harness().deps,
    );
    expect(cheaper.estimate?.judgeUsd).toBeLessThan((rubric.estimate?.judgeUsd ?? 0) / 10);

    const both = harness();
    const withBoth = await runEvals(['--cases', 'report-timezone', '--judge', '--coverage-judge'], both.deps);
    expect(withBoth.estimate?.judgeUsd).toBeGreaterThan(rubric.estimate?.judgeUsd ?? 0);
    expect(both.out()).toContain(`(claude-sonnet-5-5 rubric judge + ${JUDGE_MODEL} coverage judge)`);
    const coverage = harness();
    await runEvals(['--cases', 'report-timezone', '--coverage-judge'], coverage.deps);
    expect(coverage.out()).toContain(`(${JUDGE_MODEL} coverage judge)`);
  });

  it('refuses to execute without an API key or without the real preprocess engine, and still shows an estimate', async () => {
    const noKey = harness({ env: {} });
    expect(await runEvals(['--yes'], noKey.deps)).toMatchObject({ exitCode: 1, executed: false });
    expect(noKey.lines.at(-1)).toBe('Cannot execute: ANTHROPIC_API_KEY is not set.');
    expect(noKey.createProvider).not.toHaveBeenCalled();

    const noEngine = harness({
      createEngine: async () => {
        throw new Error('not implemented: preprocess/createPreprocessEngine');
      },
    });
    const outcome = await runEvals(['--yes'], noEngine.deps);
    expect(outcome).toMatchObject({ exitCode: 1, executed: false });
    expect(outcome.estimateUsd).toBeGreaterThan(0);
    expect(noEngine.out()).toContain('this estimate is based on raw file sizes');
    expect(noEngine.lines.at(-1)).toBe(
      'Cannot execute: the preprocess engine is not implemented in this checkout.',
    );
    expect(noEngine.createProvider).not.toHaveBeenCalled();
  });

  it('rejects bad arguments with usage and exit code 2', async () => {
    for (const argv of [
      ['--effort', 'turbo'],
      ['--reps', '0'],
      ['--reps'],
      ['--bogus'],
      ['--cases', 'nope'],
      ['--split', 'train'],
      ['--round', '1'], // a round needs --change
      ['--round', '0', '--change', 'x'],
      ['--decision', 'keep'], // a decision needs --round
      ['--round', '1', '--decision', 'maybe'],
      ['--calibrate', 'ratings.json'], // needs the results file too
      ['--sample', '0'],
    ]) {
      const h = harness();
      expect(await runEvals(argv, h.deps), argv.join(' ')).toMatchObject({ exitCode: 2, executed: false });
      expect(h.createProvider).not.toHaveBeenCalled();
    }
    const help = harness();
    expect(await runEvals(['--help'], help.deps)).toMatchObject({ exitCode: 0, executed: false });
    expect(help.out()).toBe(USAGE);
    for (const flag of [
      '--split',
      '--judge',
      '--judge-model',
      '--round',
      '--change',
      '--review-pack',
      '--calibrate',
    ]) {
      expect(USAGE, flag).toContain(flag);
    }
    expect(
      parseArgs(
        [
          '--effort',
          'high, medium,high',
          '--concurrency',
          '2',
          '--model',
          'claude-sonnet-5-5',
          '--round',
          '2',
          '--change',
          'tighter steps',
        ],
        { model: 'm', effort: 'high' },
      ),
    ).toMatchObject({
      model: 'claude-sonnet-5-5',
      efforts: ['high', 'medium'],
      concurrency: 2,
      split: 'dev',
      judge: false,
      judgeModel: 'claude-sonnet-5-5',
      round: 2,
      change: 'tighter steps',
      yes: false,
    });
  });
});

describe('runEvals — splits and case selection (M3.5)', () => {
  const idsOf = (h: ReturnType<typeof harness>): string[] =>
    h.lines.filter((l) => l.includes(' per run ')).map((l) => l.trim().split(/\s+/)[0] as string);

  it('M3.5 runs the dev split by default and leaves the test split alone', async () => {
    const h = harness();
    await runEvals([], h.deps);
    expect(idsOf(h)).toEqual(DEV.map((c) => c.id));
    expect(idsOf(h)).toContain('real-demo-1');
    for (const c of inSplit('test')) expect(idsOf(h)).not.toContain(c.id);
    expect(h.out()).toContain('(real, dev, single, 1 chunk(s),');
    expect(h.out()).toContain('no ground truth)');
    expect(h.out()).toContain(`1 real case(s) are not on this machine and were left out: ${REAL_ABSENT}`);
  });

  it('M3.5 --split test and --split all select those cases; --cases overrides the split', async () => {
    const test = harness();
    await runEvals(['--split', 'test'], test.deps);
    expect(idsOf(test)).toEqual(inSplit('test').map((c) => c.id));
    expect(idsOf(test)).toContain('real-demo-2');

    const all = harness();
    await runEvals(['--split', 'all'], all.deps);
    expect(idsOf(all)).toEqual(dataset.map((c) => c.id));

    const picked = harness();
    await runEvals(['--cases', 'real-demo-2,report-timezone'], picked.deps);
    expect(idsOf(picked).sort()).toEqual(['real-demo-2', 'report-timezone']);
    expect(picked.out()).toContain('split: selected cases   cases: 2 (1 with ground truth)');
  });

  it('M3.5 a case with options.json overrides the token budget for that case only', async () => {
    const budgets: number[] = [];
    const createEngine: CreatePreprocessEngine = async (options) => {
      const engine = await fakeEngine(options);
      return {
        run: (input) => {
          budgets.push(input.options.tokenBudget);
          return engine.run(input);
        },
      };
    };
    await runEvals(['--cases', 'real-demo-1,coupon-expiry-missing'], harness({ createEngine }).deps);
    const [synthetic, real] = budgets; // dataset order: synthetic cases first
    expect(real).toBe(12_000);
    expect(synthetic).toBeGreaterThan(12_000); // the Action default
  });
});

describe('runEvals — execution with injected doubles', () => {
  it('runs every case per variant through orchestrate, grades it and writes one results file', async () => {
    const h = harness();
    const outcome = await runEvals(['--effort', 'high,medium', '--split', 'all', '--yes'], h.deps);
    const total = dataset.length;
    const withTruth = graded.length;

    expect(outcome).toMatchObject({
      exitCode: 0,
      executed: true,
      resultsPath: expect.stringContaining('2026-11-12T09-00-'),
    });
    expect(h.createProvider.mock.calls.map((c) => c[0])).toEqual([
      { apiKey: 'sk-test', model: 'claude-opus-5-5', effort: 'high', maxOutputTokens: 32_000 },
      { apiKey: 'sk-test', model: 'claude-opus-5-5', effort: 'medium', maxOutputTokens: 32_000 },
    ]);
    expect(h.createRubricClient).not.toHaveBeenCalled();
    const [high, medium] = outcome.variants ?? [];
    expect(high?.label).toBe('claude-opus-5-5 · high');
    expect(high?.runs).toHaveLength(total);
    expect(high?.errors).toEqual([]);
    expect(high?.summary).toMatchObject({
      graded: withTruth,
      passRate: 1,
      alignmentAccuracy: 1,
      findingRecall: 1,
    });
    expect(high?.rubric).toBeNull();
    expect(high?.costUsd).toBeCloseTo(total * estimateCostUsd('claude-opus-5-5', USAGE_PER_CALL), 6);
    expect(medium?.runs).toHaveLength(total);
    expect(high?.runs[0]).toMatchObject({
      caseId: 'booking-hold-aligned',
      rep: 0,
      origin: 'synthetic',
      calls: [{ phase: 'single', model: 'claude-opus-5-5' }],
    });
    // A real-PR case has a report and a rendered comment but no deterministic grade.
    const real = high?.runs.find((r) => r.caseId === 'real-demo-1');
    expect(real).toMatchObject({ origin: 'real', grade: null });
    expect(real?.comment).toContain('## 🧪 AI QA —');
    expect(real?.comment).toContain('TC-01');
    expect(h.out()).toContain('[high] real-demo-1#1: no ground truth ($');

    const saved = JSON.parse(Object.values(h.files)[0] ?? '{}') as SavedResults;
    expect(Object.keys(h.files)[0]).toMatch(/^evals\/results\/2026-11-12T09-00-\d\d-000Z\.json$/);
    expect(saved.promptVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(saved).toMatchObject({ split: 'all', judgeModel: null });
    expect(saved.variants).toHaveLength(2);
    expect(saved.variants[0]?.runs[0]?.report.scenarios.length).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toContain('sk-test');
    expect(h.out()).toContain(`| claude-opus-5-5 · high | ${total} | 0 | — | — | — | ${withTruth} | 100% |`);
    expect(h.out()).toContain(
      `| claude-opus-5-5 · medium | ${total} | 0 | — | — | — | ${withTruth} | 100% |`,
    );
  });

  it('keeps runs that produced nothing out of the scores, with the reason and what they cost', async () => {
    const billed = { inputTokens: 3_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const h = harness({}, (c) => {
      if (c.id === 'report-timezone') return new QtgError('llm_refusal', 'declined', { usage: billed });
      if (c.id === 'search-page-cap') return new TypeError('boom');
      if (c.id === 'upload-size-scan') return nullReport('aligned');
      return oracleReport(sourceOf(c));
    });
    const outcome = await runEvals(
      ['--yes', '--cases', 'report-timezone,search-page-cap,upload-size-scan,coupon-expiry-missing'],
      h.deps,
    );
    const variant = outcome.variants?.[0];

    expect(variant?.errors.map((e) => [e.caseId, e.class])).toEqual([
      ['report-timezone', 'llm_refusal'],
      ['search-page-cap', 'internal'],
    ]);
    expect(variant?.errors[0]?.costUsd).toBeCloseTo(estimateCostUsd('claude-opus-5-5', billed), 9);
    // 2 graded: 1 oracle pass and 1 real failure; the two errors are not counted as failures.
    expect(variant?.summary).toMatchObject({ graded: 2, errors: 2, passRate: 1 / 2 });
    expect(h.out()).toContain('report-timezone#1: not graded (llm_refusal)');
    expect(h.out()).toContain('upload-size-scan#1: FAIL');
  });

  it('refuses to score a run that was served by a different model', async () => {
    const h = harness({
      createProvider: () => fakeProvider('claude-opus-5-5', undefined, 'claude-opus-4-8'),
    });
    const outcome = await runEvals(['--yes', '--cases', 'report-timezone'], h.deps);
    expect(outcome.variants?.[0]?.runs).toEqual([]);
    expect(outcome.variants?.[0]?.errors[0]).toMatchObject({
      class: 'served_model_mismatch',
      message: 'A call was served by claude-opus-4-8.',
    });

    const dated = harness({
      createProvider: () => fakeProvider('claude-opus-5-5', undefined, 'claude-opus-5-5-20260901'),
    });
    expect(
      (await runEvals(['--yes', '--cases', 'report-timezone'], dated.deps)).variants?.[0]?.runs,
    ).toHaveLength(1);
  });

  it('repeats cases with --reps and reports the pass-rate spread', async () => {
    let n = 0;
    const h = harness({}, (c) => (++n === 1 ? nullReport('aligned') : oracleReport(sourceOf(c))));
    const outcome = await runEvals(
      ['--yes', '--cases', 'report-timezone', '--reps', '3', '--concurrency', '1'],
      h.deps,
    );
    const variant = outcome.variants?.[0];
    expect(variant?.runs.map((r) => [r.rep, r.grade?.pass])).toEqual([
      [0, false],
      [1, true],
      [2, true],
    ]);
    expect(variant?.summary.passRateByRep).toEqual([0, 1, 1]);
    expect(h.out()).toContain('67% (0%–100%)');
  });

  it('--coverage-judge adds the keyword-coverage verdicts for cases with ground truth and tracks its cost', async () => {
    const h = harness();
    const outcome = await runEvals(
      ['--yes', '--coverage-judge', '--cases', 'coupon-expiry-missing,real-demo-1', '--concurrency', '1'],
      h.deps,
    );
    const [run, real] = outcome.variants?.[0]?.runs ?? [];
    expect(h.createJudgeClient).toHaveBeenCalledWith('sk-test');
    expect(h.createRubricClient).not.toHaveBeenCalled();
    expect(run?.grade?.scenarios.map((s) => s.judgeHit)).toEqual([true, false, false, false]);
    expect(run?.grade?.scenarioRecallJudge).toBe(0.25);
    expect(run?.judge?.costUsd).toBeCloseTo(
      estimateCostUsd(JUDGE_MODEL, {
        inputTokens: 3_000,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      9,
    );
    expect(real?.judge).toBeUndefined(); // nothing to check coverage against
    expect(outcome.variants?.[0]?.judgeCostUsd).toBe(run?.judge?.costUsd);
    expect(outcome.variants?.[0]?.costUsd).toBeCloseTo(
      2 * estimateCostUsd('claude-opus-5-5', USAGE_PER_CALL),
      9,
    );
  });
});

describe('runEvals — rubric judge (M3.5, docs/quality/RUBRIC.md)', () => {
  it('M3.5 --judge scores every report, with and without ground truth, and keeps the judge cost apart', async () => {
    const h = harness();
    const outcome = await runEvals(['--yes', '--judge'], h.deps);
    const variant = outcome.variants?.[0];

    expect(h.createRubricClient).toHaveBeenCalledWith('sk-test');
    expect(h.createJudgeClient).not.toHaveBeenCalled();
    expect(h.rubricBodies).toHaveLength(DEV.length);
    expect(new Set(h.rubricBodies.map((b) => b.model))).toEqual(new Set(['claude-sonnet-5-5']));

    // Scenario criteria 1/2/1/2 → 1.5. Report: alignment from the grade (oracle → 2), 1, 2 → 5/3.
    const synthetic = variant?.runs.find((r) => r.caseId === 'coupon-expiry-missing');
    expect(synthetic?.rubric).toMatchObject({
      alignmentSource: 'grade',
      judgedAlignmentCorrectness: 0,
      scenarioScore: 1.5,
      unscoredScenarios: [],
    });
    expect(synthetic?.rubric?.report.alignmentCorrectness).toBe(2);
    expect(synthetic?.rubric?.overall).toBeCloseTo(0.5 * 1.5 + 0.5 * (5 / 3), 9);
    // Without ground truth the judge's own alignment score (0) stands: report (0 + 1 + 2) / 3 = 1.
    const real = variant?.runs.find((r) => r.caseId === 'real-demo-1');
    expect(real?.grade).toBeNull();
    expect(real?.rubric).toMatchObject({ alignmentSource: 'judge', scenarioScore: 1.5, reportScore: 1 });
    expect(real?.rubric?.overall).toBeCloseTo(1.25, 9);

    const expectedOverall =
      (DEV_GRADED.length * (0.75 + 5 / 6) + (DEV.length - DEV_GRADED.length) * 1.25) / DEV.length;
    expect(variant?.rubric?.judged).toBe(DEV.length);
    expect(variant?.rubric?.overall).toBeCloseTo(expectedOverall, 9);
    expect(variant?.rubric?.criteria).toMatchObject({
      actionability: 1,
      traceability: 2,
      concision: 1,
      honesty: 2,
    });
    expect(variant?.summary.graded).toBe(DEV_GRADED.length);

    expect(variant?.judgeCostUsd).toBeCloseTo(DEV.length * RUBRIC_COST, 9);
    expect(variant?.costUsd).toBeCloseTo(DEV.length * estimateCostUsd('claude-opus-5-5', USAGE_PER_CALL), 9);
    expect(synthetic?.rubricJudge).toMatchObject({ model: 'claude-sonnet-5-5', costUsd: RUBRIC_COST });
    expect(h.out()).toContain('coupon-expiry-missing#1: pass, overall 1.58 ($');
    expect(h.out()).toContain('real-demo-1#1: no ground truth, overall 1.25 ($');
    expect(h.out()).toContain(
      `| claude-opus-5-5 · high | ${DEV.length} | 0 | ${expectedOverall.toFixed(2)} | 1.50 |`,
    );
    const saved = JSON.parse(Object.values(h.files)[0] ?? '{}') as SavedResults;
    expect(saved.judgeModel).toBe('claude-sonnet-5-5');
  });

  it('M3.5 the judge is shown the PRD, the change, the rendered comment and the report data', async () => {
    const h = harness();
    await runEvals(
      ['--yes', '--judge', '--judge-model', 'claude-opus-5-5', '--cases', 'coupon-expiry-missing'],
      h.deps,
    );
    const body = h.rubricBodies[0] as RubricBody;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    const prompt = String(body.messages[0]?.content);
    for (const tag of ['<prd>', '<code_change>', '<rendered_comment>', '<report_data>'])
      expect(prompt).toContain(tag);
    expect(prompt).toContain('## 🧪 AI QA —');
    expect(prompt).toContain('@@ ');
    // The expected answers are never shown to the judge.
    const coupon = graded.find((c) => c.id === 'coupon-expiry-missing') as GradedCase;
    expect(prompt).not.toContain(coupon.expected.notes);
  });

  it('M3.5 a judge that fails leaves the run and its deterministic grade standing, without a rubric score', async () => {
    const h = harness({
      createRubricClient: () => ({
        messages: {
          parse: async () => {
            throw new Error('overloaded');
          },
        },
      }),
    });
    const outcome = await runEvals(['--yes', '--judge', '--cases', 'coupon-expiry-missing'], h.deps);
    const run = outcome.variants?.[0]?.runs[0];
    expect(run?.grade?.pass).toBe(true);
    expect(run?.rubric).toBeUndefined();
    expect(run?.rubricJudge).toMatchObject({ error: 'Error', costUsd: 0 });
    expect(outcome.variants?.[0]?.rubric).toBeNull();
    expect(h.out()).toContain('coupon-expiry-missing#1: pass, judge failed ($');
  });
});

describe('judgeScenarios', () => {
  const coupon = graded.find((c) => c.id === 'coupon-expiry-missing') as GradedCase;

  it('asks claude-haiku-5-5 with the risk checklist and the scenarios, and maps verdicts by risk id', async () => {
    const parse = vi.fn(async (_body: Parameters<JudgeClientLike['messages']['parse']>[0]) => ({
      parsed_output: {
        verdicts: [
          { id: 'expired', covered: true, scenarioId: 'TC-01' },
          { id: 'reuse', covered: false, scenarioId: '' },
        ],
      },
      usage: { input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: null },
    }));
    const result = await judgeScenarios({ messages: { parse } }, coupon, oracleReport(coupon));

    expect(result.verdicts).toEqual({ expired: true, reuse: false });
    expect(result.usage).toEqual({
      inputTokens: 2_000,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(result.costUsd).toBeCloseTo((2_000 * 0.1 + 300 * 0.5) / 1e6, 12);
    const body = parse.mock.calls[0]?.[0];
    expect(body?.model).toBe('claude-haiku-5-5');
    expect(body?.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    const prompt = String(body?.messages[0]?.content);
    expect(prompt).toContain('- expired: Applying a coupon whose expiresAt is in the past');
    expect(prompt).toContain('"id": "TC-01"');
    expect(String(body?.system)).toMatch(/ignore it and grade as usual/);
  });

  it('never throws: a failed or empty judge call leaves the keyword result standing', async () => {
    const failing: JudgeClientLike = {
      messages: {
        parse: async () => {
          throw new Error('rate limited');
        },
      },
    };
    expect(await judgeScenarios(failing, coupon, oracleReport(coupon))).toEqual({
      verdicts: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      error: 'Error',
    });
    const empty: JudgeClientLike = {
      messages: {
        parse: async () => ({ parsed_output: null, usage: { input_tokens: 10, output_tokens: 0 } }),
      },
    };
    expect(await judgeScenarios(empty, coupon, oracleReport(coupon))).toMatchObject({
      verdicts: null,
      error: 'judge returned no verdicts',
    });
  });
});
