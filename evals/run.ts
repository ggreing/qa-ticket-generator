/**
 * Eval runner (SPEC §12.3, M3.5): case → preprocess → orchestrate (real provider) → grade → judge.
 *
 * It calls the same `orchestrate`, prompts, normalization and renderer the Action uses, with the
 * Action's default configuration, so a score here describes what ships. Nothing is sent to the
 * API until the estimated cost (run and judge shown separately) has been printed and `--yes`
 * was given. Offline modes (`--regrade`, `--review-pack`, `--calibrate`, `--decision`) never call it.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import { parseRepoConfig, resolveConfig } from '../src/core/config';
import type {
  CreatePreprocessEngine,
  Effort,
  FinalReport,
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
import { renderPrComment } from '../src/delivery/render/markdown';
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
import { type RegradedVariant, regradeResults } from './regrade';
import { rejudgeResults } from './rejudge';
import { buildReviewPack, calibrate } from './review';
import { decideRound, recordRound } from './rounds';
import {
  DEFAULT_RUBRIC_MODEL,
  JUDGE_OUTPUT_BASE_TOKENS,
  JUDGE_OUTPUT_TOKENS_PER_TICKET,
  judgeWithRubric,
  RUBRIC_VERSION,
  type RubricClientLike,
  type RubricScore,
  type RubricSummary,
  summarizeRubric,
} from './rubric';
import { type EvalCase, type GradedCase, inputHashOf, loadDataset } from './schema';

/** The Action's own limits (src/core/limits.ts), so the eval runs and estimates exactly like production. */
export const PRODUCTION = {
  expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
  mapConcurrency: MAP_CONCURRENCY,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
} as const;
/** Rough size of one judge call, for the pre-run estimate only. */
const COVERAGE_JUDGE_ESTIMATE: LlmUsage = {
  inputTokens: 5_000,
  outputTokens: 1_500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
/** The rubric judge reads the case again plus the rendered report, and writes a reason per score. */
const RUBRIC_JUDGE_EXTRA_INPUT = 9_000;
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface RunOptions {
  model: string;
  efforts: Effort[];
  caseIds: string[];
  /** Which part of the data to run. `test` is meant to be touched once, at the end. */
  split: 'dev' | 'test' | 'all';
  reps: number;
  concurrency: number;
  /** Score every report with the rubric judge. */
  judge: boolean;
  judgeModel: string;
  /** Also ask the keyword-coverage judge (cases with ground truth only). */
  coverageJudge: boolean;
  yes: boolean;
  help: boolean;
  /** Path of a saved results file to re-grade offline, or null for a normal run. */
  regrade: string | null;
  /** Path of a saved results file whose reports are scored again with the current rubric. */
  rejudge: string | null;
  /** With `regrade`: cases whose inputs were edited after the saved run (for files without hashes). */
  edited: string[];
  /** Improvement round this run belongs to; writes evals/rounds/<n>/ and updates ROUNDS.md. */
  round: number | null;
  change: string;
  decision: 'keep' | 'revert' | null;
  reviewPack: string | null;
  sample: number;
  out: string | null;
  /** [ratings.json, results.json] */
  calibrate: [string, string] | null;
}

export interface ProviderRequest {
  apiKey: string;
  model: string;
  effort: Effort;
  maxOutputTokens: number;
}

export interface RunDeps {
  /** The `evals/` directory: cases/, real/, splits.json, real-sources.json, rounds/, ROUNDS.md. */
  evalsRoot: string;
  resultsRoot: string;
  env: Record<string, string | undefined>;
  print: (line: string) => void;
  now: () => number;
  createEngine: CreatePreprocessEngine;
  createProvider: (request: ProviderRequest) => LlmProvider;
  createJudgeClient: (apiKey: string) => JudgeClientLike;
  createRubricClient: (apiKey: string) => RubricClientLike;
  writeFile: (path: string, text: string) => void;
  readFile: (path: string) => string;
}

export interface RunRecord {
  caseId: string;
  rep: number;
  origin?: 'synthetic' | 'real';
  /** Hash of what the model was shown (PR, files, PRD). Lets a re-grade detect edited cases. */
  inputHash?: string;
  /** Deterministic grade; null for cases without ground truth. */
  grade: CaseGrade | null;
  /** Rubric judge scores, when the judge ran and answered. */
  rubric?: RubricScore;
  report: QaReport;
  raw: QaReport;
  /** The PR comment as the Action would post it for this report. */
  comment?: string;
  mode?: PreprocessOutput['mode'];
  calls: CallRecord[];
  usage: LlmUsage;
  costUsd: number;
  seconds: number;
  warnings: string[];
  judge?: { usage: LlmUsage; costUsd: number; error?: string };
  rubricJudge?: { model: string; usage: LlmUsage; costUsd: number; error?: string };
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
  rubric: RubricSummary | null;
  costUsd: number;
  judgeCostUsd: number;
}

/** What `evals/results/<timestamp>.json` holds. */
export interface SavedResults {
  startedAt: string;
  promptVersion: string;
  split: string;
  judgeModel: string | null;
  estimateUsd: number;
  /** Rubric the scores were judged with. Absent when no judge ran, and in files written under rubric v1. */
  rubricVersion?: number;
  /** Set by --rejudge: the results file whose reports were scored again, and when. */
  rejudgedFrom?: string;
  rejudgedAt?: string;
  variants: VariantResult[];
}

export interface RunOutcome {
  exitCode: number;
  executed: boolean;
  /** Run and judge estimate together. */
  estimateUsd: number;
  estimate?: { runUsd: number; judgeUsd: number };
  resultsPath?: string;
  variants?: VariantResult[];
  regraded?: RegradedVariant[];
}

export const USAGE = `Usage: node evals/cli.mjs run [options]

Run (prints the plan and the estimated cost; calls the API only with --yes):
  --model <id>          model to evaluate (default: the Action's default model)
  --effort <a,b>        effort level(s); several values run one variant each, e.g. high,medium
  --split <name>        dev (default), test or all; test is meant for the final run only
  --cases <id,id>       run only these cases, whatever their split
  --reps <n>            repetitions per case and variant (default: 1)
  --concurrency <n>     cases in flight at once (default: 3)
  --judge               score every report with the rubric judge (docs/quality/RUBRIC.md)
  --judge-model <id>    rubric judge model (default: ${DEFAULT_RUBRIC_MODEL})
  --coverage-judge      also judge must-cover scenarios with ${JUDGE_MODEL} (cases with ground truth)
  --round <n>           record this run as improvement round n, 0 for the baseline
                        (evals/rounds/<n>/, evals/ROUNDS.md); prints a keep/revert recommendation
  --change "<text>"     what changed in this round (required with --round)
  --yes                 actually call the API

Offline (no API call, no key):
  --rejudge <file>      score the reports of a saved results file again with the current rubric;
                        calls only the judge, prints its cost first and needs --yes like a run.
                        With --round <n> the new scores are recorded for that round.
  --regrade <file>      re-grade a saved results file with the current cases and rules
  --edited <id,id>      with --regrade: cases whose PR, files or PRD changed since that run
  --review-pack <file>  write a blind rating pack for people from a results file
  --sample <n>          with --review-pack: how many reports to include (default: 5)
  --out <path>          with --review-pack: where to write the pack
  --calibrate <ratings.json> <results.json>
                        compare people's ratings with the rubric judge, per criterion
  --round <n> --decision keep|revert
                        record the decision for a round
  --help                show this text

Needs ANTHROPIC_API_KEY when run with --yes.`;

/** Parses CLI arguments. Throws an Error with a user-facing message on bad input. */
export function parseArgs(argv: string[], defaults: { model: string; effort: Effort }): RunOptions {
  const options: RunOptions = {
    model: defaults.model,
    efforts: [defaults.effort],
    caseIds: [],
    split: 'dev',
    reps: 1,
    concurrency: 3,
    judge: false,
    judgeModel: DEFAULT_RUBRIC_MODEL,
    coverageJudge: false,
    yes: false,
    help: false,
    regrade: null,
    rejudge: null,
    edited: [],
    round: null,
    change: '',
    decision: null,
    reviewPack: null,
    sample: 5,
    out: null,
    calibrate: null,
  };
  const list = (value: string): string[] =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  const count = (flag: string, value: string, max = 20, min = 1): number => {
    const n = Number(value);
    if (value.trim() === '' || !Number.isInteger(n) || n < min || n > max)
      throw new Error(`${flag} must be an integer from ${min} to ${max}.`);
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
    else if (flag === '--coverage-judge') options.coverageJudge = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--model') options.model = value();
    else if (flag === '--judge-model') options.judgeModel = value();
    else if (flag === '--cases') options.caseIds = list(value());
    else if (flag === '--regrade') options.regrade = value();
    else if (flag === '--rejudge') options.rejudge = value();
    else if (flag === '--edited') options.edited = list(value());
    else if (flag === '--review-pack') options.reviewPack = value();
    else if (flag === '--out') options.out = value();
    else if (flag === '--change') options.change = value();
    else if (flag === '--calibrate') options.calibrate = [value(), value()];
    else if (flag === '--reps') options.reps = count(flag, value());
    else if (flag === '--concurrency') options.concurrency = count(flag, value());
    else if (flag === '--sample') options.sample = count(flag, value(), 50);
    // Round 0 is the baseline, measured before anything is changed.
    else if (flag === '--round') options.round = count(flag, value(), 99, 0);
    else if (flag === '--split') {
      const split = value();
      if (split !== 'dev' && split !== 'test' && split !== 'all')
        throw new Error('--split takes dev, test or all.');
      options.split = split;
    } else if (flag === '--decision') {
      const decision = value();
      if (decision !== 'keep' && decision !== 'revert') throw new Error('--decision takes keep or revert.');
      options.decision = decision;
    } else if (flag === '--effort') {
      const efforts = list(value());
      const bad = efforts.filter((e) => !EFFORTS.includes(e as Effort));
      if (efforts.length === 0 || bad.length > 0) {
        throw new Error(`--effort takes one or more of: ${EFFORTS.join(', ')}.`);
      }
      options.efforts = [...new Set(efforts)] as Effort[];
    } else throw new Error(`Unknown option ${flag}.`);
  }
  if (options.decision && options.round === null) throw new Error('--decision needs --round <n>.');
  if (
    options.round !== null &&
    !options.decision &&
    options.rejudge === null &&
    options.change.trim() === ''
  ) {
    throw new Error('--round needs --change "<what changed in this round>".');
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

/** The served model may be a dated snapshot of the requested alias, nothing else. */
const servedBy = (requested: string, served: string): boolean =>
  served === requested || served.startsWith(`${requested}-`);

const hasGroundTruth = (c: EvalCase): c is GradedCase => c.expected !== null;

/**
 * Runs the eval. Prints the plan and its estimated cost first; unless `--yes` is present it
 * stops there without creating a provider or making any request.
 */
export async function runEvals(argv: string[], deps: RunDeps): Promise<RunOutcome> {
  const { print } = deps;
  const none = (exitCode: number): RunOutcome => ({ exitCode, executed: false, estimateUsd: 0 });
  const cfg = resolveConfig((name) => (name === 'anthropic-api-key' ? 'eval' : ''), parseRepoConfig(null));

  let options: RunOptions;
  try {
    options = parseArgs(argv, { model: cfg.model, effort: cfg.effort });
  } catch (err) {
    print((err as Error).message);
    print(USAGE);
    return none(2);
  }
  if (options.help) {
    print(USAGE);
    return none(0);
  }

  let all: EvalCase[];
  let missingReal: string[];
  try {
    ({ cases: all, missingReal } = loadDataset(deps.evalsRoot));
  } catch (err) {
    print((err as Error).message);
    return none(2);
  }

  // ── offline modes ───────────────────────────────────────────────────────────
  if (options.regrade !== null) return regradeResults(options.regrade, all, deps, options.edited);
  // Calls the judge (and only the judge), behind the same --yes gate as a run.
  if (options.rejudge !== null) return rejudgeResults(options.rejudge, all, options, deps);
  if (options.reviewPack !== null) return buildReviewPack(options.reviewPack, all, options, deps);
  if (options.calibrate !== null) return calibrate(options.calibrate[0], options.calibrate[1], deps);
  if (options.decision !== null && options.round !== null)
    return decideRound(options.round, options.decision, deps);

  const unknown = options.caseIds.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) {
    print(`Unknown eval case(s): ${unknown.join(', ')}`);
    return none(2);
  }
  const cases =
    options.caseIds.length > 0
      ? all.filter((c) => options.caseIds.includes(c.id))
      : all.filter((c) => options.split === 'all' || c.split === options.split);
  if (cases.length === 0) {
    print(`No eval cases in split "${options.split}".`);
    return none(2);
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
      options: { ...cfg.preprocess, ...(evalCase.options ?? {}) },
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
  const perCase = prepared.map(({ evalCase, pre, context }) => {
    const judgeUsd = options.judge
      ? estimateCostUsd(options.judgeModel, {
          ...ZERO,
          inputTokens: pre.estimatedTokens + RUBRIC_JUDGE_EXTRA_INPUT,
          outputTokens: JUDGE_OUTPUT_BASE_TOKENS + JUDGE_OUTPUT_TOKENS_PER_TICKET * cfg.maxScenarios,
        })
      : 0;
    const coverageUsd =
      options.coverageJudge && hasGroundTruth(evalCase)
        ? estimateCostUsd(JUDGE_MODEL, COVERAGE_JUDGE_ESTIMATE)
        : 0;
    return {
      id: evalCase.id,
      estimateUsd: pre.chunks.length === 0 ? 0 : planRun(pre.chunks, pricing, context, guard).estimateUsd,
      judgeUsd: judgeUsd + coverageUsd,
      shape: `${evalCase.origin ?? 'synthetic'}, ${evalCase.split ?? '-'}, ${pre.mode}, ${pre.chunks.length} chunk(s), ~${pre.estimatedTokens} input tokens${hasGroundTruth(evalCase) ? '' : ', no ground truth'}`,
    };
  });
  const variants = options.efforts.length;
  const runUsd = perCase.reduce((n, c) => n + c.estimateUsd, 0) * options.reps * variants;
  const judgeUsd = perCase.reduce((n, c) => n + c.judgeUsd, 0) * options.reps * variants;
  const estimateUsd = runUsd + judgeUsd;
  const estimate = { runUsd, judgeUsd };
  const runsPerVariant = cases.length * options.reps;

  print(`Eval plan — prompt ${PROMPT_VERSION}`);
  print(`  model: ${options.model}   effort: ${options.efforts.join(', ')}   reps: ${options.reps}`);
  print(
    `  split: ${options.caseIds.length > 0 ? 'selected cases' : options.split}   cases: ${cases.length} (${cases.filter(hasGroundTruth).length} with ground truth)`,
  );
  for (const c of perCase) {
    print(`    ${c.id.padEnd(30)} ~$${c.estimateUsd.toFixed(2)} per run   (${c.shape})`);
  }
  if (missingReal.length > 0) {
    print(
      `  NOTE: ${missingReal.length} real case(s) are not on this machine and were left out: ${missingReal.join(', ')}`,
    );
  }
  print(`  runs: ${runsPerVariant} per variant × ${variants} variant(s)`);
  print(`  estimated run cost:   ~$${runUsd.toFixed(2)} (${options.model})`);
  print(
    `  estimated judge cost: ~$${judgeUsd.toFixed(2)}${options.judge ? ` (${options.judgeModel} rubric judge${options.coverageJudge ? ` + ${JUDGE_MODEL} coverage judge` : ''})` : options.coverageJudge ? ` (${JUDGE_MODEL} coverage judge)` : ' (no judge; add --judge for rubric scores)'}`,
  );
  print(`  estimated total:      ~$${estimateUsd.toFixed(2)}`);
  print(
    `  The run estimate assumes ${PRODUCTION.expectedOutputTokens} output tokens per call, the same assumption as the Action's cost guard.`,
  );
  if (!engineReady) {
    print('  NOTE: the preprocess engine is not available yet, so this estimate is based on raw file sizes.');
  }

  if (!options.yes) {
    print('Nothing was sent to the API. Re-run with --yes to execute.');
    return { exitCode: 0, executed: false, estimateUsd, estimate };
  }
  if (!engineReady) {
    print('Cannot execute: the preprocess engine is not implemented in this checkout.');
    return { exitCode: 1, executed: false, estimateUsd, estimate };
  }
  const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    print('Cannot execute: ANTHROPIC_API_KEY is not set.');
    return { exitCode: 1, executed: false, estimateUsd, estimate };
  }

  // ── execute ─────────────────────────────────────────────────────────────────
  const coverageClient = options.coverageJudge ? deps.createJudgeClient(apiKey) : null;
  const rubricClient = options.judge ? deps.createRubricClient(apiKey) : null;
  const startedAt = deps.now();
  const results: VariantResult[] = [];

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
        const seconds = (deps.now() - started) / 1000;
        const stray = rec.calls.find((c) => !servedBy(options.model, c.model));
        if (stray) {
          fail('served_model_mismatch', `A call was served by ${stray.model}.`, result.usage);
          return;
        }
        const raw = rec.lastReport() ?? result.report;
        let grade = hasGroundTruth(evalCase) ? gradeCase(evalCase, { report: result.report, raw }) : null;

        // The comment exactly as the Action would post it; the judge and reviewers rate this.
        const final: FinalReport = {
          status: 'ok',
          pr: evalCase.pr,
          report: result.report,
          language: cfg.language,
          meta: {
            model: options.model,
            effort,
            mode: pre.mode,
            sha: evalCase.pr.headSha,
            usage: result.usage,
            costUsd: result.costUsd,
            durationMs: seconds * 1000,
            calls: result.calls,
            skipped: [...pre.skipped, ...result.skipped],
            redactions: pre.redactions,
            prdSources: evalCase.prdDocuments.map((d) => d.ref),
            warnings: result.warnings,
            dryRun: false,
          },
        };
        const comment = renderPrComment(final);

        let judge: RunRecord['judge'];
        if (coverageClient && grade && hasGroundTruth(evalCase)) {
          const verdict = await judgeScenarios(coverageClient, evalCase, result.report);
          if (verdict.verdicts) grade = withJudgeVerdicts(grade, verdict.verdicts);
          judge = {
            usage: verdict.usage,
            costUsd: verdict.costUsd,
            ...(verdict.error ? { error: verdict.error } : {}),
          };
        }
        let rubric: RubricScore | undefined;
        let rubricJudge: RunRecord['rubricJudge'];
        if (rubricClient) {
          const scored = await judgeWithRubric(
            rubricClient,
            options.judgeModel,
            evalCase,
            result.report,
            comment,
            grade,
          );
          rubric = scored.score ?? undefined;
          rubricJudge = {
            model: scored.model,
            usage: scored.usage,
            costUsd: scored.costUsd,
            ...(scored.error ? { error: scored.error } : {}),
          };
        }

        runs.push({
          caseId: evalCase.id,
          rep,
          origin: evalCase.origin ?? 'synthetic',
          inputHash: inputHashOf(evalCase),
          grade,
          ...(rubric ? { rubric } : {}),
          report: result.report,
          raw,
          comment,
          mode: pre.mode,
          calls: rec.calls,
          usage: result.usage,
          costUsd: result.costUsd,
          seconds,
          warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
          ...(judge ? { judge } : {}),
          ...(rubricJudge ? { rubricJudge } : {}),
        });
        const verdict = grade ? (grade.pass ? 'pass' : 'FAIL') : 'no ground truth';
        const overall = rubric
          ? `, overall ${rubric.overall.toFixed(2)}`
          : rubricJudge?.error
            ? ', judge failed'
            : '';
        print(
          `  [${effort}] ${evalCase.id}#${rep + 1}: ${verdict}${overall} ($${result.costUsd.toFixed(2)})`,
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
    const grades = (rs: RunRecord[]): CaseGrade[] => rs.flatMap((r) => (r.grade ? [r.grade] : []));
    const byRep = Array.from({ length: options.reps }, (_, rep) => grades(runs.filter((r) => r.rep === rep)));
    results.push({
      label,
      model: options.model,
      effort,
      runs,
      errors,
      summary: summarize(grades(runs), errors.length, byRep),
      rubric: summarizeRubric(runs.flatMap((r) => (r.rubric ? [r.rubric] : []))),
      costUsd: runs.reduce((n, r) => n + r.costUsd, 0) + errors.reduce((n, e) => n + e.costUsd, 0),
      judgeCostUsd: runs.reduce((n, r) => n + (r.judge?.costUsd ?? 0) + (r.rubricJudge?.costUsd ?? 0), 0),
    });
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const table = formatSummaryTable(results.map(summaryRow));
  const started = new Date(startedAt).toISOString();
  const saved: SavedResults = {
    startedAt: started,
    promptVersion: PROMPT_VERSION,
    split: options.caseIds.length > 0 ? 'selected' : options.split,
    judgeModel: options.judge ? options.judgeModel : null,
    ...(options.judge ? { rubricVersion: RUBRIC_VERSION } : {}),
    estimateUsd,
    variants: results,
  };
  const json = `${JSON.stringify(saved, null, 2)}\n`;
  const resultsPath =
    options.round === null
      ? join(deps.resultsRoot, `${started.replace(/[:.]/g, '-')}.json`)
      : join(deps.evalsRoot, 'rounds', String(options.round), 'raw', 'results.json');
  deps.writeFile(resultsPath, json);

  print('');
  print(table);
  print('');
  print(`Results written to ${resultsPath}`);
  // Last, so the recommendation is the final thing on screen.
  if (options.round !== null) recordRound(options.round, options.change, saved, table, deps);
  return { exitCode: 0, executed: true, estimateUsd, estimate, resultsPath, variants: results };
}

/** One row of the summary table for a variant. */
export function summaryRow(v: VariantResult): SummaryRow {
  return {
    label: v.label,
    runs: v.runs.length,
    summary: v.summary,
    rubric: v.rubric,
    costUsd: v.costUsd,
    judgeCostUsd: v.judgeCostUsd,
    avgSeconds: v.runs.length > 0 ? v.runs.reduce((n, r) => n + r.seconds, 0) / v.runs.length : 0,
  };
}
