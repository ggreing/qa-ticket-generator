/**
 * Eval runner (SPEC §12.3): case → preprocess → orchestrate (real provider) → grade.
 *
 * It calls the same `orchestrate`, prompts and normalization the Action uses, with the Action's
 * default configuration, so a score here describes what ships. Nothing is sent to the API until
 * the estimated cost has been printed and `--yes` was given.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import { parseRepoConfig, resolveConfig } from '../src/core/config';
import type {
  CreatePreprocessEngine,
  Effort,
  GenerateRequest,
  LlmProvider,
  LlmResult,
  LlmUsage,
  MergeRequest,
  PreprocessEngine,
  PreprocessOutput,
  PromptContext,
  QaReport,
} from '../src/core/contracts';
import { QtgError } from '../src/core/errors';
import { EXPECTED_OUTPUT_TOKENS, MAP_CONCURRENCY, MAX_OUTPUT_TOKENS } from '../src/core/limits';
import { orchestrate, planRun } from '../src/llm/orchestrate';
import { estimateCostUsd } from '../src/llm/pricing';
import { PROMPT_VERSION } from '../src/llm/prompts/system';
import {
  type CaseGrade,
  formatSummaryTable,
  gradeCase,
  type Summary,
  type SummaryRow,
  summarize,
  withJudgeVerdicts,
} from './grade';
import { JUDGE_MODEL, type JudgeClientLike, judgeScenarios } from './judge';
import { type EvalCase, loadCases } from './schema';

/** The Action's own limits (src/core/limits.ts), so the eval runs and estimates exactly like production. */
export const PRODUCTION = {
  expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
  mapConcurrency: MAP_CONCURRENCY,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
} as const;
/** Rough size of one judge call, for the pre-run estimate only. */
const JUDGE_ESTIMATE: LlmUsage = {
  inputTokens: 5_000,
  outputTokens: 1_500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface RunOptions {
  model: string;
  efforts: Effort[];
  caseIds: string[];
  reps: number;
  concurrency: number;
  judge: boolean;
  yes: boolean;
  help: boolean;
}

export interface ProviderRequest {
  apiKey: string;
  model: string;
  effort: Effort;
  maxOutputTokens: number;
}

export interface RunDeps {
  casesRoot: string;
  resultsRoot: string;
  env: Record<string, string | undefined>;
  print: (line: string) => void;
  now: () => number;
  createEngine: CreatePreprocessEngine;
  createProvider: (request: ProviderRequest) => LlmProvider;
  createJudgeClient: (apiKey: string) => JudgeClientLike;
  writeFile: (path: string, text: string) => void;
}

export interface RunRecord {
  caseId: string;
  rep: number;
  grade: CaseGrade;
  report: QaReport;
  raw: QaReport;
  calls: CallRecord[];
  usage: LlmUsage;
  costUsd: number;
  seconds: number;
  warnings: string[];
  judge?: { usage: LlmUsage; costUsd: number; error?: string };
}

/** A run that produced nothing to grade. Kept apart from grades so plumbing is never scored as a model failure. */
export interface RunError {
  caseId: string;
  rep: number;
  /** QtgError code (llm_refusal, llm_truncated, llm_unavailable, …), `served_model_mismatch` or `internal`. */
  class: string;
  message: string;
  usage: LlmUsage;
  costUsd: number;
}

export interface CallRecord {
  phase: 'single' | 'map' | 'merge';
  model: string;
  stopReason: string;
  usage: LlmUsage;
  seconds: number;
}

export interface VariantResult {
  label: string;
  model: string;
  effort: Effort;
  runs: RunRecord[];
  errors: RunError[];
  summary: Summary;
  costUsd: number;
  judgeCostUsd: number;
}

export interface RunOutcome {
  exitCode: number;
  executed: boolean;
  estimateUsd: number;
  resultsPath?: string;
  variants?: VariantResult[];
}

export const USAGE = `Usage: node evals/cli.mjs run [options]

  --model <id>          model to evaluate (default: the Action's default model)
  --effort <a,b>        effort level(s); several values run one variant each, e.g. high,medium
  --cases <id,id>       run only these cases (default: all)
  --reps <n>            repetitions per case and variant (default: 1)
  --concurrency <n>     cases in flight at once (default: 3)
  --judge               also grade scenario coverage with ${JUDGE_MODEL}
  --yes                 actually call the API; without it only the plan and estimated cost are printed
  --help                show this text

Needs ANTHROPIC_API_KEY when run with --yes.`;

/** Parses CLI arguments. Throws an Error with a user-facing message on bad input. */
export function parseArgs(argv: string[], defaults: { model: string; effort: Effort }): RunOptions {
  const options: RunOptions = {
    model: defaults.model,
    efforts: [defaults.effort],
    caseIds: [],
    reps: 1,
    concurrency: 3,
    judge: false,
    yes: false,
    help: false,
  };
  const list = (value: string): string[] =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  const count = (flag: string, value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error(`${flag} must be an integer from 1 to 20.`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
      return v;
    };
    if (flag === '--yes') options.yes = true;
    else if (flag === '--judge') options.judge = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--model') options.model = value();
    else if (flag === '--cases') options.caseIds = list(value());
    else if (flag === '--reps') options.reps = count(flag, value());
    else if (flag === '--concurrency') options.concurrency = count(flag, value());
    else if (flag === '--effort') {
      const efforts = list(value());
      const bad = efforts.filter((e) => !EFFORTS.includes(e as Effort));
      if (efforts.length === 0 || bad.length > 0) {
        throw new Error(`--effort takes one or more of: ${EFFORTS.join(', ')}.`);
      }
      options.efforts = [...new Set(efforts)] as Effort[];
    } else throw new Error(`Unknown option ${flag}.`);
  }
  return options;
}

/** Stand-in used only to size the estimate while the real preprocess engine is unavailable. */
const sizeOnlyEngine: PreprocessEngine = {
  run: (input) => {
    const chars = input.files.reduce((n, f) => n + (f.patch?.length ?? 0) + (f.headContent?.length ?? 0), 0);
    const estimatedTokens = Math.ceil(chars / 3.2);
    return {
      mode: 'single',
      chunks: [{ id: 'size-only', files: [], estimatedTokens }],
      prdDocuments: input.prdDocuments,
      skipped: [],
      redactions: [],
      estimatedTokens,
    };
  },
};

/** Wraps a provider to keep every call's model, stop reason, usage and timing, plus the last report. */
function recording(provider: LlmProvider, now: () => number) {
  const calls: CallRecord[] = [];
  let last: QaReport | undefined;
  const track = async (phase: CallRecord['phase'], run: () => Promise<LlmResult<QaReport>>) => {
    const started = now();
    const result = await run();
    calls.push({
      phase,
      model: result.model,
      stopReason: result.stopReason,
      usage: result.usage,
      seconds: (now() - started) / 1000,
    });
    last = result.value;
    return result;
  };
  const wrapped: LlmProvider = {
    id: provider.id,
    generateReport: (req: GenerateRequest, signal) =>
      track(req.phase, () => provider.generateReport(req, signal)),
    mergeReports: (req: MergeRequest, signal) => track('merge', () => provider.mergeReports(req, signal)),
    estimateCostUsd: (usage) => provider.estimateCostUsd(usage),
  };
  return { provider: wrapped, calls, lastReport: () => last };
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await worker(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const add = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/** The served model may be a dated snapshot of the requested alias, nothing else. */
const servedBy = (requested: string, served: string): boolean =>
  served === requested || served.startsWith(`${requested}-`);

/**
 * Runs the eval. Prints the plan and its estimated cost first; unless `--yes` is present it
 * stops there without creating a provider or making any request.
 */
export async function runEvals(argv: string[], deps: RunDeps): Promise<RunOutcome> {
  const { print } = deps;
  const cfg = resolveConfig((name) => (name === 'anthropic-api-key' ? 'eval' : ''), parseRepoConfig(null));

  let options: RunOptions;
  try {
    options = parseArgs(argv, { model: cfg.model, effort: cfg.effort });
  } catch (err) {
    print((err as Error).message);
    print(USAGE);
    return { exitCode: 2, executed: false, estimateUsd: 0 };
  }
  if (options.help) {
    print(USAGE);
    return { exitCode: 0, executed: false, estimateUsd: 0 };
  }

  let cases: EvalCase[];
  try {
    cases = loadCases(deps.casesRoot, options.caseIds);
  } catch (err) {
    print((err as Error).message);
    return { exitCode: 2, executed: false, estimateUsd: 0 };
  }

  // ── preprocess (no network) ─────────────────────────────────────────────────
  let engine: PreprocessEngine;
  let engineReady = true;
  try {
    engine = await deps.createEngine({ astLanguages: cfg.preprocess.astLanguages });
  } catch {
    engine = sizeOnlyEngine;
    engineReady = false;
  }
  const prepared = cases.map((evalCase) => {
    const pre: PreprocessOutput = engine.run({
      files: evalCase.files,
      prdDocuments: evalCase.prdDocuments,
      options: cfg.preprocess,
    });
    const { pr } = evalCase;
    const context: PromptContext = {
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        htmlUrl: pr.htmlUrl,
        author: pr.author,
        baseRef: pr.baseRef,
        headRef: pr.headRef,
      },
      prdDocuments: pre.prdDocuments,
      language: cfg.language,
      maxScenarios: cfg.maxScenarios,
    };
    return { evalCase, pre, context };
  });

  // ── plan and estimated cost ─────────────────────────────────────────────────
  const pricing = { estimateCostUsd: (usage: LlmUsage) => estimateCostUsd(options.model, usage) };
  const guard = { maxCostUsd: cfg.maxCostUsd, expectedOutputTokens: PRODUCTION.expectedOutputTokens };
  const perCase = prepared.map(({ evalCase, pre, context }) => ({
    id: evalCase.id,
    estimateUsd: pre.chunks.length === 0 ? 0 : planRun(pre.chunks, pricing, context, guard).estimateUsd,
    shape: `${pre.mode}, ${pre.chunks.length} chunk(s), ~${pre.estimatedTokens} input tokens, ${pre.skipped.length} file(s) skipped`,
  }));
  const perVariant = perCase.reduce((n, c) => n + c.estimateUsd, 0) * options.reps;
  const runsPerVariant = cases.length * options.reps;
  const judgeEstimate = options.judge
    ? estimateCostUsd(JUDGE_MODEL, JUDGE_ESTIMATE) * runsPerVariant * options.efforts.length
    : 0;
  const estimateUsd = perVariant * options.efforts.length + judgeEstimate;

  print(`Eval plan — prompt ${PROMPT_VERSION}`);
  print(`  model: ${options.model}   effort: ${options.efforts.join(', ')}   reps: ${options.reps}`);
  print(`  cases (${cases.length}): ${cases.map((c) => c.id).join(', ')}`);
  for (const c of perCase) {
    print(`    ${c.id.padEnd(28)} ~$${c.estimateUsd.toFixed(2)} per run   (${c.shape})`);
  }
  print(`  runs: ${runsPerVariant} per variant × ${options.efforts.length} variant(s)`);
  print(
    `  estimated cost: ~$${perVariant.toFixed(2)} per variant, ~$${estimateUsd.toFixed(2)} in total${options.judge ? ` (includes ~$${judgeEstimate.toFixed(2)} for the ${JUDGE_MODEL} judge)` : ''}`,
  );
  print(
    `  The estimate assumes ${PRODUCTION.expectedOutputTokens} output tokens per call, the same assumption as the Action's cost guard.`,
  );
  if (!engineReady) {
    print('  NOTE: the preprocess engine is not available yet, so this estimate is based on raw file sizes.');
  }

  if (!options.yes) {
    print('Nothing was sent to the API. Re-run with --yes to execute.');
    return { exitCode: 0, executed: false, estimateUsd };
  }
  if (!engineReady) {
    print('Cannot execute: the preprocess engine is not implemented in this checkout.');
    return { exitCode: 1, executed: false, estimateUsd };
  }
  const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    print('Cannot execute: ANTHROPIC_API_KEY is not set.');
    return { exitCode: 1, executed: false, estimateUsd };
  }

  // ── execute ─────────────────────────────────────────────────────────────────
  const judgeClient = options.judge ? deps.createJudgeClient(apiKey) : null;
  const startedAt = deps.now();
  const variants: VariantResult[] = [];

  for (const effort of options.efforts) {
    const label = `${options.model} · ${effort}`;
    // Server-side fallback stays off: a score served by another model would measure that model.
    const provider = deps.createProvider({
      apiKey,
      model: options.model,
      effort,
      maxOutputTokens: PRODUCTION.maxOutputTokens,
    });
    const runs: RunRecord[] = [];
    const errors: RunError[] = [];
    const jobs = Array.from({ length: options.reps }, (_, rep) =>
      prepared.map((p) => ({ ...p, rep })),
    ).flat();

    await pool(jobs, options.concurrency, async ({ evalCase, pre, context, rep }) => {
      const rec = recording(provider, deps.now);
      const started = deps.now();
      const fail = (cls: string, message: string, usage: LlmUsage): void => {
        errors.push({
          caseId: evalCase.id,
          rep,
          class: cls,
          message,
          usage,
          costUsd: provider.estimateCostUsd(usage),
        });
        print(`  [${effort}] ${evalCase.id}#${rep + 1}: not graded (${cls})`);
      };
      try {
        const result = await orchestrate(
          pre,
          rec.provider,
          context,
          { ...guard, concurrency: PRODUCTION.mapConcurrency },
          new AbortController().signal,
        );
        const stray = rec.calls.find((c) => !servedBy(options.model, c.model));
        if (stray) {
          fail('served_model_mismatch', `A call was served by ${stray.model}.`, result.usage);
          return;
        }
        let grade = gradeCase(evalCase, { report: result.report, raw: rec.lastReport() ?? result.report });
        let judge: RunRecord['judge'];
        if (judgeClient) {
          const verdict = await judgeScenarios(judgeClient, evalCase, result.report);
          if (verdict.verdicts) grade = withJudgeVerdicts(grade, verdict.verdicts);
          judge = {
            usage: verdict.usage,
            costUsd: verdict.costUsd,
            ...(verdict.error ? { error: verdict.error } : {}),
          };
        }
        runs.push({
          caseId: evalCase.id,
          rep,
          grade,
          report: result.report,
          raw: rec.lastReport() ?? result.report,
          calls: rec.calls,
          usage: result.usage,
          costUsd: result.costUsd,
          seconds: (deps.now() - started) / 1000,
          warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
          ...(judge ? { judge } : {}),
        });
        print(
          `  [${effort}] ${evalCase.id}#${rep + 1}: ${grade.pass ? 'pass' : 'FAIL'} ($${result.costUsd.toFixed(2)})`,
        );
      } catch (err) {
        if (err instanceof QtgError) fail(err.code, err.userMessage, err.usage ?? ZERO);
        else fail('internal', err instanceof Error ? err.name : 'unknown error', ZERO);
      }
    });

    const order = (a: { caseId: string; rep: number }, b: { caseId: string; rep: number }) =>
      a.rep - b.rep || a.caseId.localeCompare(b.caseId);
    runs.sort(order);
    errors.sort(order);
    const byRep = Array.from({ length: options.reps }, (_, rep) =>
      runs.filter((r) => r.rep === rep).map((r) => r.grade),
    );
    variants.push({
      label,
      model: options.model,
      effort,
      runs,
      errors,
      summary: summarize(
        runs.map((r) => r.grade),
        errors.length,
        byRep,
      ),
      costUsd: runs.reduce((n, r) => n + r.costUsd, 0) + errors.reduce((n, e) => n + e.costUsd, 0),
      judgeCostUsd: runs.reduce((n, r) => n + (r.judge?.costUsd ?? 0), 0),
    });
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const rows: SummaryRow[] = variants.map((v) => ({
    label: v.label,
    summary: v.summary,
    costUsd: v.costUsd,
    judgeCostUsd: v.judgeCostUsd,
    avgSeconds: v.runs.length > 0 ? v.runs.reduce((n, r) => n + r.seconds, 0) / v.runs.length : 0,
  }));
  const table = formatSummaryTable(rows);
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const resultsPath = join(deps.resultsRoot, `${stamp}.json`);
  deps.writeFile(
    resultsPath,
    `${JSON.stringify(
      {
        startedAt: new Date(startedAt).toISOString(),
        promptVersion: PROMPT_VERSION,
        options: { ...options, yes: undefined, help: undefined },
        production: PRODUCTION,
        estimateUsd,
        totalUsage: variants.flatMap((v) => v.runs).reduce((u, r) => add(u, r.usage), ZERO),
        variants,
      },
      null,
      2,
    )}\n`,
  );
  print('');
  print(table);
  print('');
  print(`Results written to ${resultsPath}`);
  return { exitCode: 0, executed: true, estimateUsd, resultsPath, variants };
}
