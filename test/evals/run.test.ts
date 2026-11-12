import { describe, expect, it, vi } from 'vitest';
import { JUDGE_MODEL, type JudgeClientLike, judgeScenarios } from '../../evals/judge';
import { PRODUCTION, parseArgs, type RunDeps, runEvals, USAGE } from '../../evals/run';
import { type EvalCase, loadCases } from '../../evals/schema';
import type { GenerateRequest, LlmProvider, QaReport } from '../../src/core/contracts';
import { QtgError } from '../../src/core/errors';
import { estimateCostUsd } from '../../src/llm/pricing';
import { CASES_ROOT, fakeEngine, nullReport, oracleReport } from './support';

const cases = loadCases(CASES_ROOT);
const byPr = new Map(cases.map((c) => [c.pr.number, c]));
const caseFor = (req: GenerateRequest): EvalCase => byPr.get(req.context.pr.number) as EvalCase;
const USAGE_PER_CALL = { inputTokens: 4_000, outputTokens: 6_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

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
      const answer = respond ? respond(c) : oracleReport(c);
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
  let clock = Date.UTC(2026, 10, 12, 9, 0, 0);
  const createProvider = vi.fn((request: { model: string }) => fakeProvider(request.model, respond));
  const createJudgeClient = vi.fn(
    (): JudgeClientLike => ({
      messages: {
        parse: async () => ({
          parsed_output: { verdicts: [{ id: 'expired', covered: true, scenarioId: 'S-01' }] },
          usage: { input_tokens: 3_000, output_tokens: 400 },
        }),
      },
    }),
  );
  const deps: RunDeps = {
    casesRoot: CASES_ROOT,
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
    writeFile: (path, text) => {
      files[path.replace(/\\/g, '/')] = text;
    },
    readFile: (path) => {
      const text = files[path.replace(/\\/g, '/')];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    ...overrides,
  };
  return { deps, lines, files, createProvider, createJudgeClient, out: () => lines.join('\n') };
}

describe('runEvals — cost confirmation gate', () => {
  it('SPEC §12.3 without --yes it prints the plan and the estimated cost, and creates no provider', async () => {
    const h = harness();
    const outcome = await runEvals(['--effort', 'high,medium'], h.deps);

    expect(outcome).toMatchObject({ exitCode: 0, executed: false });
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.createJudgeClient).not.toHaveBeenCalled();
    expect(h.files).toEqual({});
    expect(h.out()).toContain('model: claude-opus-5-5   effort: high, medium   reps: 1');
    expect(h.out()).toContain('runs: 10 per variant × 2 variant(s)');
    expect(h.out()).toMatch(/estimated cost: ~\$\d+\.\d\d per variant, ~\$\d+\.\d\d in total/);
    expect(h.lines.at(-1)).toBe('Nothing was sent to the API. Re-run with --yes to execute.');
    // 10 small single-call cases at the guard's 12K-output assumption on Opus 5.5: about $0.25 each.
    expect(outcome.estimateUsd).toBeGreaterThan(4.5);
    expect(outcome.estimateUsd).toBeLessThan(5.5);
    expect(PRODUCTION).toEqual({ expectedOutputTokens: 12_000, mapConcurrency: 3, maxOutputTokens: 32_000 });
  });

  it('the estimate scales with reps and variants and adds the judge', async () => {
    const one = await runEvals(['--cases', 'report-timezone'], harness().deps);
    const many = await runEvals(
      ['--cases', 'report-timezone', '--reps', '3', '--effort', 'high,medium'],
      harness().deps,
    );
    expect(many.estimateUsd).toBeCloseTo(one.estimateUsd * 6, 6);
    const judged = harness();
    const withJudge = await runEvals(['--cases', 'report-timezone', '--judge'], judged.deps);
    expect(withJudge.estimateUsd).toBeGreaterThan(one.estimateUsd);
    expect(judged.out()).toContain(`for the ${JUDGE_MODEL} judge`);
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
    ]) {
      const h = harness();
      expect(await runEvals(argv, h.deps), argv.join(' ')).toMatchObject({ exitCode: 2, executed: false });
      expect(h.createProvider).not.toHaveBeenCalled();
    }
    const help = harness();
    expect(await runEvals(['--help'], help.deps)).toMatchObject({ exitCode: 0, executed: false });
    expect(help.out()).toBe(USAGE);
    expect(
      parseArgs(['--effort', 'high, medium,high', '--concurrency', '2', '--model', 'claude-sonnet-5-5'], {
        model: 'm',
        effort: 'high',
      }),
    ).toMatchObject({
      model: 'claude-sonnet-5-5',
      efforts: ['high', 'medium'],
      concurrency: 2,
      yes: false,
    });
  });
});

describe('runEvals — execution with injected doubles', () => {
  it('runs every case per variant through orchestrate, grades it and writes one results file', async () => {
    const h = harness();
    const outcome = await runEvals(['--effort', 'high,medium', '--yes'], h.deps);

    expect(outcome).toMatchObject({
      exitCode: 0,
      executed: true,
      resultsPath: expect.stringContaining('2026-11-12T09-00-'),
    });
    expect(h.createProvider.mock.calls.map((c) => c[0])).toEqual([
      { apiKey: 'sk-test', model: 'claude-opus-5-5', effort: 'high', maxOutputTokens: 32_000 },
      { apiKey: 'sk-test', model: 'claude-opus-5-5', effort: 'medium', maxOutputTokens: 32_000 },
    ]);
    const [high, medium] = outcome.variants ?? [];
    expect(high?.label).toBe('claude-opus-5-5 · high');
    expect(high?.runs).toHaveLength(10);
    expect(high?.errors).toEqual([]);
    expect(high?.summary).toMatchObject({
      graded: 10,
      passRate: 1,
      alignmentAccuracy: 1,
      findingRecall: 1,
      injectionFlagged: '1/1',
    });
    expect(high?.costUsd).toBeCloseTo(10 * estimateCostUsd('claude-opus-5-5', USAGE_PER_CALL), 6);
    expect(medium?.runs).toHaveLength(10);
    expect(high?.runs[0]).toMatchObject({
      caseId: 'booking-hold-aligned',
      rep: 0,
      calls: [{ phase: 'single', model: 'claude-opus-5-5' }],
    });

    const saved = JSON.parse(Object.values(h.files)[0] ?? '{}');
    expect(Object.keys(h.files)[0]).toMatch(/^evals\/results\/2026-11-12T09-00-\d\d-000Z\.json$/);
    expect(saved.promptVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(saved.variants).toHaveLength(2);
    expect(saved.variants[0].runs[0].report.scenarios.length).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toContain('sk-test');
    expect(h.out()).toContain('| claude-opus-5-5 · high | 10 | 0 | 100% |');
    expect(h.out()).toContain('| claude-opus-5-5 · medium | 10 | 0 | 100% |');
  });

  it('keeps runs that produced nothing out of the scores, with the reason and what they cost', async () => {
    const billed = { inputTokens: 3_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const h = harness({}, (c) => {
      if (c.id === 'report-timezone') return new QtgError('llm_refusal', 'declined', { usage: billed });
      if (c.id === 'search-page-cap') return new TypeError('boom');
      if (c.id === 'upload-size-scan') return nullReport('aligned');
      return oracleReport(c);
    });
    const outcome = await runEvals(['--yes'], h.deps);
    const variant = outcome.variants?.[0];

    expect(variant?.errors.map((e) => [e.caseId, e.class])).toEqual([
      ['report-timezone', 'llm_refusal'],
      ['search-page-cap', 'internal'],
    ]);
    expect(variant?.errors[0]?.costUsd).toBeCloseTo(estimateCostUsd('claude-opus-5-5', billed), 9);
    // 8 graded: 7 oracle passes and 1 real failure; the two errors are not counted as failures.
    expect(variant?.summary).toMatchObject({ graded: 8, errors: 2, passRate: 7 / 8 });
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
    const h = harness({}, (c) => (++n === 1 ? nullReport('aligned') : oracleReport(c)));
    const outcome = await runEvals(
      ['--yes', '--cases', 'report-timezone', '--reps', '3', '--concurrency', '1'],
      h.deps,
    );
    const variant = outcome.variants?.[0];
    expect(variant?.runs.map((r) => [r.rep, r.grade.pass])).toEqual([
      [0, false],
      [1, true],
      [2, true],
    ]);
    expect(variant?.summary.passRateByRep).toEqual([0, 1, 1]);
    expect(h.out()).toContain('67% (0%–100%)');
  });

  it('--judge adds the judge verdicts and tracks its cost separately', async () => {
    const h = harness();
    const outcome = await runEvals(['--yes', '--judge', '--cases', 'coupon-expiry-missing'], h.deps);
    const run = outcome.variants?.[0]?.runs[0];
    expect(h.createJudgeClient).toHaveBeenCalledWith('sk-test');
    expect(run?.grade.scenarios.map((s) => s.judgeHit)).toEqual([true, false, false, false]);
    expect(run?.grade.scenarioRecallJudge).toBe(0.25);
    expect(run?.judge?.costUsd).toBeCloseTo(
      estimateCostUsd(JUDGE_MODEL, {
        inputTokens: 3_000,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      9,
    );
    expect(outcome.variants?.[0]?.judgeCostUsd).toBe(run?.judge?.costUsd);
    expect(outcome.variants?.[0]?.costUsd).toBeCloseTo(estimateCostUsd('claude-opus-5-5', USAGE_PER_CALL), 9);
  });
});

describe('judgeScenarios', () => {
  const coupon = cases.find((c) => c.id === 'coupon-expiry-missing') as EvalCase;

  it('asks claude-haiku-5-5 with the risk checklist and the scenarios, and maps verdicts by risk id', async () => {
    const parse = vi.fn(async (_body: Parameters<JudgeClientLike['messages']['parse']>[0]) => ({
      parsed_output: {
        verdicts: [
          { id: 'expired', covered: true, scenarioId: 'S-01' },
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
    expect(prompt).toContain('"id": "S-01"');
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
