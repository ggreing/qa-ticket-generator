/**
 * Eval paths for v3 (SPEC v3 §8).
 *
 *   plan    spec only -> generatePlan -> deterministic grade (+ rubric v3 judge with --judge)
 *   verify  cases from a saved plan run + the case's PR files -> verifyCases -> code status grade
 *
 * Both use the product's own functions, prompts and defaults, print the plan and its estimated
 * cost first, and call the API only with `--yes`.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import { caseIdFor, lintCaseStyle, specKey } from '../../src/cases';
import type { LintCaseStyle, PlanRequest, QaCase, VerifyRequest, VerifyResult } from '../../src/core/cases';
import { parseRepoConfig, type QtgConfig, resolveConfig } from '../../src/core/config';
import type {
  CreatePreprocessEngine,
  Effort,
  LlmProvider,
  LlmUsage,
  PreprocessOutput,
} from '../../src/core/contracts';
import { QtgError } from '../../src/core/errors';
import {
  EXPECTED_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  PLAN_EXPECTED_OUTPUT_TOKENS,
} from '../../src/core/limits';
import { generatePlan, type PlanDiagnostics, planPlanRun } from '../../src/llm/plan';
import { estimateCostUsd } from '../../src/llm/pricing';
import { PLAN_PROMPT_VERSION } from '../../src/llm/prompts/plan';
import { VERIFY_PROMPT_VERSION } from '../../src/llm/prompts/verify';
import { planVerifyRun, verifyCases } from '../../src/llm/verify';
import type { RubricClientLike } from '../rubric';
import type { ProviderRequest } from '../run';
import { type EvalCase, type GradedCase, inputHashOf, loadDataset } from '../schema';
import { COVERAGE_MODEL, estimateCoverageCost, judgeMustCover } from './coverage';
import {
  fallbackLint,
  gradePlan,
  gradeVerify,
  type PlanGrade,
  type PlanSummary,
  summarizePlan,
  summarizeVerify,
  type VerifyGrade,
  type VerifySummary,
  withCoverageVerdicts,
} from './grade';
import { rescorePlan } from './rejudge';
import { buildReviewPackV3, calibrateV3 } from './review';
import { decideRoundV3, recordRoundV3, roundResultsPath } from './rounds';
import {
  DEFAULT_JUDGE_MODEL,
  estimateJudgeCost,
  judgeSheet,
  RUBRIC_V3_VERSION,
  type RubricSummaryV3,
  type SheetScore,
  summarizeSheets,
} from './rubric';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Code-derived cases asked for per pull request in the verify eval. */
const MAX_NEW_CASES = 10;
/** Cases a requirement is assumed to yield, for sizing the judge estimate before any call (round 0: 12–18). */
const CASES_PER_REQUIREMENT = 15;
const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export interface V3Deps {
  evalsRoot: string;
  resultsRoot: string;
  env: Record<string, string | undefined>;
  print: (line: string) => void;
  now: () => number;
  createEngine: CreatePreprocessEngine;
  createProvider: (request: ProviderRequest) => LlmProvider;
  createRubricClient: (apiKey: string) => RubricClientLike;
  writeFile: (path: string, text: string) => void;
  readFile: (path: string) => string;
  /** Style lint to count violations with. Default: the cases module's, or a stand-in until it exists. */
  lint?: LintCaseStyle;
}

export interface V3Options {
  model: string;
  effort: Effort;
  split: 'dev' | 'test' | 'all';
  caseIds: string[];
  language: string | null;
  judge: boolean;
  judgeModel: string;
  concurrency: number;
  /** verify: the plan results file whose cases are judged against code. */
  from: string | null;
  /** Check must-cover risks with the coverage judge (any language). On unless turned off. */
  coverageJudge: boolean;
  /** plan: record the run as improvement round n. */
  round: number | null;
  change: string;
  decision: 'keep' | 'revert' | null;
  reviewPack: string | null;
  sample: number;
  out: string | null;
  /** [ratings.json, plan-results.json] */
  calibrate: [string, string] | null;
  /** plan: score the sheets of this results file again with the rubric judge. */
  rejudge: string | null;
  /** plan: recompute the deterministic metrics of this results file. Offline. */
  regrade: string | null;
  yes: boolean;
  help: boolean;
}

export const USAGE_V3 = `Usage: node evals/cli.mjs plan [options]      spec -> QA case sheet
       node evals/cli.mjs verify --from <plan-results.json> [options]   cases + PR code -> code status

Both print the plan and the estimated cost, and call the API only with --yes.
  --model <id>          model to evaluate (default: the Action's default model)
  --effort <level>      effort level (default: the Action's default)
  --split <name>        dev (default), test or all
  --cases <id,id>       only these cases, whatever their split
  --language <code>     language of the cases: en (default), ko, ja, zh-CN
  --concurrency <n>     specs in flight at once (default: 2)
  --yes                 actually call the API
plan only:
  --no-coverage-judge   skip the must-cover check by meaning (${COVERAGE_MODEL}); keywords only
  --round <n>           record the run as improvement round n, 0 for the baseline
                        (evals/rounds/v3/<n>/, evals/ROUNDS.v3.md); prints a keep/revert recommendation
  --change "<text>"     what changed in this round (required with --round)
plan, scoring saved sheets again (nothing is generated):
  --rejudge <plan-results.json> [--round <n>] [--cases <id,id>]
                        rubric judge again, with the rubric as it is now; needs --yes like a run.
                        With --round the round's record is replaced and keeps its decision.
  --regrade <plan-results.json> [--round <n>] [--cases <id,id>]
                        style lint and keyword must-cover again; offline, no key
plan, offline (no API call, no key):
  --round <n> --decision keep|revert     record the decision for a round
  --review-pack <plan-results.json> [--sample <n>] [--out <path>]
                        blind rating pack of the sheets, in the language they were written in
  --calibrate <ratings.json> <plan-results.json>
                        compare a person's ratings with the rubric v3 judge
plan, judge:
  --judge               score every sheet with the rubric v3 judge (docs/quality/RUBRIC.md)
  --judge-model <id>    judge model (default: ${DEFAULT_JUDGE_MODEL})
verify only:
  --from <file>         results of a plan run; its cases are judged against each case's PR`;

export function parseV3Args(argv: string[], defaults: { model: string; effort: Effort }): V3Options {
  const o: V3Options = {
    model: defaults.model,
    effort: defaults.effort,
    split: 'dev',
    caseIds: [],
    language: null,
    judge: false,
    judgeModel: DEFAULT_JUDGE_MODEL,
    concurrency: 2,
    from: null,
    coverageJudge: true,
    round: null,
    change: '',
    decision: null,
    reviewPack: null,
    sample: 5,
    out: null,
    calibrate: null,
    rejudge: null,
    regrade: null,
    yes: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
      return v;
    };
    if (flag === '--yes') o.yes = true;
    else if (flag === '--judge') o.judge = true;
    else if (flag === '--help' || flag === '-h') o.help = true;
    else if (flag === '--model') o.model = value();
    else if (flag === '--judge-model') o.judgeModel = value();
    else if (flag === '--language') o.language = value();
    else if (flag === '--from') o.from = value();
    else if (flag === '--no-coverage-judge') o.coverageJudge = false;
    else if (flag === '--change') o.change = value();
    else if (flag === '--review-pack') o.reviewPack = value();
    else if (flag === '--rejudge') o.rejudge = value();
    else if (flag === '--regrade') o.regrade = value();
    else if (flag === '--out') o.out = value();
    else if (flag === '--calibrate') o.calibrate = [value(), value()];
    else if (flag === '--round' || flag === '--sample') {
      const n = Number(value());
      const [min, max] = flag === '--round' ? [0, 99] : [1, 50];
      if (!Number.isInteger(n) || n < min || n > max)
        throw new Error(`${flag} must be an integer from ${min} to ${max}.`);
      if (flag === '--round') o.round = n;
      else o.sample = n;
    } else if (flag === '--decision') {
      const d = value();
      if (d !== 'keep' && d !== 'revert') throw new Error('--decision takes keep or revert.');
      o.decision = d;
    } else if (flag === '--cases')
      o.caseIds = value()
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    else if (flag === '--concurrency') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 10)
        throw new Error('--concurrency must be an integer from 1 to 10.');
      o.concurrency = n;
    } else if (flag === '--split') {
      const split = value();
      if (split !== 'dev' && split !== 'test' && split !== 'all')
        throw new Error('--split takes dev, test or all.');
      o.split = split;
    } else if (flag === '--effort') {
      const effort = value();
      if (!EFFORTS.includes(effort as Effort))
        throw new Error(`--effort takes one of: ${EFFORTS.join(', ')}.`);
      o.effort = effort as Effort;
    } else throw new Error(`Unknown option ${flag}.`);
  }
  if (o.decision && o.round === null) throw new Error('--decision needs --round <n>.');
  if (o.rejudge !== null && o.regrade !== null)
    throw new Error('--rejudge and --regrade cannot be combined; --rejudge regrades as well.');
  const rescore = o.rejudge !== null || o.regrade !== null;
  if (rescore && o.decision) throw new Error('--decision cannot be combined with --rejudge or --regrade.');
  // A round scored again keeps the change text it was recorded with.
  if (o.round !== null && !o.decision && !rescore && o.change.trim() === '') {
    throw new Error('--round needs --change "<what changed in this round>".');
  }
  return o;
}

export interface PlanRun {
  caseId: string;
  origin: 'synthetic' | 'real';
  inputHash: string;
  cases: QaCase[];
  /** Null for specs without ground truth. */
  grade: PlanGrade | null;
  rubric?: SheetScore;
  judge?: { model: string; usage: LlmUsage; costUsd: number; error?: string; attempts?: number };
  usage: LlmUsage;
  costUsd: number;
  calls: number;
  dropped: number;
  /** What the merge step did to this sheet. Absent in results written before it was recorded. */
  merge?: PlanDiagnostics;
  coverageJudge?: { usage: LlmUsage; costUsd: number; error?: string };
  warnings: string[];
  seconds: number;
}

export interface RunErrorV3 {
  caseId: string;
  class: string;
  message: string;
  costUsd: number;
}

export interface PlanResults {
  kind: 'plan';
  startedAt: string;
  promptVersion: string;
  language: string;
  split: string;
  model: string;
  effort: Effort;
  judgeModel: string | null;
  rubricVersion: number | null;
  /** Which lint counted style violations: the cases module's, or the stand-in. */
  lintSource: 'cases' | 'fallback';
  runs: PlanRun[];
  errors: RunErrorV3[];
  summary: PlanSummary;
  rubric: RubricSummaryV3 | null;
  costUsd: number;
  judgeCostUsd: number;
}

export interface VerifyRun {
  caseId: string;
  cases: number;
  result: Pick<VerifyResult, 'statuses' | 'newCases' | 'alignment'>;
  grade: VerifyGrade | null;
  mode: PreprocessOutput['mode'];
  usage: LlmUsage;
  costUsd: number;
  calls: number;
  warnings: string[];
  seconds: number;
}

export interface VerifyResults {
  kind: 'verify';
  startedAt: string;
  promptVersion: string;
  planPromptVersion: string;
  from: string;
  language: string;
  split: string;
  model: string;
  effort: Effort;
  runs: VerifyRun[];
  errors: RunErrorV3[];
  summary: VerifySummary;
  costUsd: number;
}

export interface V3Outcome {
  exitCode: number;
  executed: boolean;
  estimateUsd: number;
  estimate?: { runUsd: number; judgeUsd: number };
  resultsPath?: string;
  plan?: PlanResults;
  verify?: VerifyResults;
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const none = (exitCode: number): V3Outcome => ({ exitCode, executed: false, estimateUsd: 0 });

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await worker(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** The lint to count style violations with, and where it came from. */
export function resolveLint(deps: Pick<V3Deps, 'lint'>): {
  lint: LintCaseStyle;
  source: 'cases' | 'fallback';
} {
  if (deps.lint) return { lint: deps.lint, source: 'cases' };
  try {
    lintCaseStyle(
      {
        title: 'x',
        acLabels: [],
        technique: 'happy_path',
        priority: 'P2',
        preconditions: [],
        testData: [],
        steps: ['x'],
        expected: ['x'],
        whyEasyToMiss: '',
        origin: 'spec',
      },
      'en',
    );
    return { lint: lintCaseStyle, source: 'cases' };
  } catch {
    return { lint: fallbackLint, source: 'fallback' };
  }
}

/** Ids for a sheet in an eval run, in the format the sync engine uses: `<spec>-C01`. */
export function assignIds(
  specId: string,
  drafts: Omit<QaCase, 'caseId' | 'specRef' | 'lifecycle'>[],
): QaCase[] {
  // The engine's own id rule, so a case here carries the id its ticket would.
  const base = specKey(specId);
  return drafts.map((d, i) => ({
    ...d,
    caseId: caseIdFor(base, i + 1),
    specRef: specId,
    lifecycle: 'active' as const,
  }));
}

interface Setup {
  options: V3Options;
  cfg: QtgConfig;
  cases: EvalCase[];
  missingReal: string[];
}

function setup(argv: string[], deps: V3Deps): Setup | V3Outcome {
  const configFor = (language: string): QtgConfig =>
    resolveConfig(
      (name) => (name === 'anthropic-api-key' ? 'eval' : name === 'language' ? language : ''),
      parseRepoConfig(null),
    );
  const defaults = configFor('');
  let options: V3Options;
  let cfg: QtgConfig;
  try {
    options = parseV3Args(argv, { model: defaults.model, effort: defaults.effort });
    cfg = configFor(options.language ?? '');
  } catch (err) {
    deps.print(err instanceof QtgError ? err.userMessage : (err as Error).message);
    deps.print(USAGE_V3);
    return none(2);
  }
  if (options.help) {
    deps.print(USAGE_V3);
    return none(0);
  }
  const { cases: all, missingReal } = loadDataset(deps.evalsRoot);
  const unknown = options.caseIds.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) {
    deps.print(`Unknown eval case(s): ${unknown.join(', ')}`);
    return none(2);
  }
  const cases =
    options.caseIds.length > 0
      ? all.filter((c) => options.caseIds.includes(c.id))
      : all.filter((c) => options.split === 'all' || c.split === options.split);
  return { options, cfg, cases, missingReal };
}

const isOutcome = (s: Setup | V3Outcome): s is V3Outcome => 'exitCode' in s;
const hasTruth = (c: EvalCase): c is GradedCase => c.expected !== null;

function planRequestFor(evalCase: EvalCase, cfg: QtgConfig): PlanRequest {
  const [spec, ...related] = evalCase.prdDocuments;
  return {
    spec: spec as PlanRequest['spec'],
    related,
    existing: [],
    language: cfg.language,
    maxCases: cfg.maxCases,
  };
}

export function formatPlanTable(
  r: Pick<
    PlanResults,
    'model' | 'effort' | 'runs' | 'errors' | 'summary' | 'rubric' | 'costUsd' | 'judgeCostUsd'
  >,
): string {
  const header = [
    'Variant',
    'Specs',
    'Errors',
    'Overall',
    'Case',
    'Sheet',
    'Spec coverage',
    'Cases/spec',
    'Must-cover (kw)',
    'Must-cover (judge)',
    'Req. with a case',
    'Style viol./100',
    'Repeated titles',
    'Merged away',
    'Cost',
    'Judge cost',
  ];
  const s = r.summary;
  const score = (n: number | undefined): string => (n === undefined ? '—' : n.toFixed(2));
  const graded = r.runs.some((x) => x.grade !== null);
  const row = [
    `${r.model} · ${r.effort}`,
    r.runs.length,
    r.errors.length,
    score(r.rubric?.overall),
    score(r.rubric?.caseScore),
    score(r.rubric?.sheetScore),
    score(r.rubric?.criteria.coverage),
    s.casesPerSpec.toFixed(1),
    graded ? pct(s.mustCoverRecall) : '—',
    s.mustCoverRecallJudge === null ? '—' : pct(s.mustCoverRecallJudge),
    graded ? pct(s.requirementCoverage) : '—',
    s.styleViolationsPer100.toFixed(1),
    s.repeatedTitles,
    r.runs.reduce((n, x) => n + (x.merge?.mergedAway.length ?? 0), 0),
    `$${r.costUsd.toFixed(2)}`,
    r.judgeCostUsd > 0 ? `$${r.judgeCostUsd.toFixed(2)}` : '—',
  ];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    `| ${row.join(' | ')} |`,
  ].join('\n');
}

/** `plan`: spec only -> the QA case sheet, graded. */
export async function runPlanEval(argv: string[], deps: V3Deps): Promise<V3Outcome> {
  const s = setup(argv, deps);
  if (isOutcome(s)) return s;
  const { options, cfg, missingReal } = s;
  const { print } = deps;
  // ── offline modes: no key, no API call ──────────────────────────────────────
  if (options.reviewPack !== null) {
    return none(
      buildReviewPackV3(
        options.reviewPack,
        loadDataset(deps.evalsRoot).cases,
        options.sample,
        options.out,
        deps,
      ),
    );
  }
  if (options.calibrate !== null) return none(calibrateV3(options.calibrate[0], options.calibrate[1], deps));
  if (options.decision !== null && options.round !== null)
    return none(decideRoundV3(options.round, options.decision, deps));
  if (options.rejudge !== null) return rescorePlan(options.rejudge, 'rejudge', options, deps);
  if (options.regrade !== null) return rescorePlan(options.regrade, 'regrade', options, deps);
  const withSpec = s.cases.filter((c) => c.prdDocuments.length > 0);
  const withoutSpec = s.cases.filter((c) => c.prdDocuments.length === 0).map((c) => c.id);
  if (withSpec.length === 0) {
    print('No eval case with a spec in this selection.');
    return none(2);
  }

  const pricing = { estimateCostUsd: (usage: LlmUsage) => estimateCostUsd(options.model, usage) };
  // The same figure the plan pipeline estimates with (measured in round 0: 13k–23k per call).
  const guard = { maxCostUsd: cfg.maxCostUsd, expectedOutputTokens: PLAN_EXPECTED_OUTPUT_TOKENS };
  const planned = withSpec.map((evalCase) => {
    const req = planRequestFor(evalCase, cfg);
    const plan = planPlanRun(req, pricing, guard);
    const expectedCases = Math.min(
      cfg.maxCases,
      Math.max(8, plan.requirements.length * CASES_PER_REQUIREMENT),
    );
    return {
      evalCase,
      req,
      plan,
      judgeUsd:
        (options.judge ? estimateJudgeCost(options.judgeModel, req.spec, expectedCases) : 0) +
        (options.coverageJudge && hasTruth(evalCase)
          ? estimateCoverageCost(expectedCases, evalCase.expected.mustScenarios.length)
          : 0),
    };
  });
  const runUsd = planned.reduce((n, p) => n + p.plan.estimateUsd, 0);
  const judgeUsd = planned.reduce((n, p) => n + p.judgeUsd, 0);
  const estimate = { runUsd, judgeUsd };
  const estimateUsd = runUsd + judgeUsd;

  print(`Plan eval — prompt ${PLAN_PROMPT_VERSION}`);
  print(
    `  model: ${options.model}   effort: ${options.effort}   language: ${cfg.language}   max-cases: ${cfg.maxCases}`,
  );
  print(
    `  split: ${options.caseIds.length > 0 ? 'selected cases' : options.split}   specs: ${withSpec.length} (${withSpec.filter(hasTruth).length} with ground truth)`,
  );
  for (const p of planned) {
    const calls = p.plan.groups.length + (p.plan.merge ? 1 : 0);
    print(
      `    ${p.evalCase.id.padEnd(30)} ~$${p.plan.estimateUsd.toFixed(2)}   (${p.plan.requirements.length} requirement(s), ${calls} call(s)${p.plan.skipped.length > 0 ? ', some left out by the cost cap' : ''})`,
    );
  }
  if (withoutSpec.length > 0) print(`  left out, no spec to plan from: ${withoutSpec.join(', ')}`);
  if (missingReal.length > 0)
    print(`  NOTE: ${missingReal.length} real case(s) are not on this machine and were left out.`);
  print(`  estimated run cost:   ~$${runUsd.toFixed(2)} (${options.model})`);
  const judges = [
    ...(options.judge ? [`${options.judgeModel}, rubric v${RUBRIC_V3_VERSION}`] : []),
    ...(options.coverageJudge ? [`${COVERAGE_MODEL} must-cover check`] : []),
  ];
  print(
    `  estimated judge cost: ~$${judgeUsd.toFixed(2)} (${judges.length > 0 ? judges.join(' + ') : 'no judge'}${options.judge ? '' : '; add --judge for rubric scores'})`,
  );
  print(`  estimated total:      ~$${estimateUsd.toFixed(2)}`);
  print(`  The run estimate assumes ${PLAN_EXPECTED_OUTPUT_TOKENS} output tokens per call.`);
  if (!options.yes) {
    print('Nothing was sent to the API. Re-run with --yes to execute.');
    return { exitCode: 0, executed: false, estimateUsd, estimate };
  }
  const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    print('Cannot execute: ANTHROPIC_API_KEY is not set.');
    return { exitCode: 1, executed: false, estimateUsd, estimate };
  }

  const provider = deps.createProvider({
    apiKey,
    model: options.model,
    effort: options.effort,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  const judgeClient = options.judge ? deps.createRubricClient(apiKey) : null;
  const coverageClient = options.coverageJudge ? deps.createRubricClient(apiKey) : null;
  const { lint, source: lintSource } = resolveLint(deps);
  const startedAt = new Date(deps.now()).toISOString();
  const runs: PlanRun[] = [];
  const errors: RunErrorV3[] = [];

  await pool(planned, options.concurrency, async ({ evalCase, req }) => {
    const started = deps.now();
    try {
      const result = await generatePlan(req, provider, guard, new AbortController().signal);
      const cases = assignIds(
        req.spec.ref.id,
        result.cases.map(({ reuseCaseId: _reuse, ...draft }) => draft),
      );
      let grade = hasTruth(evalCase) ? gradePlan(evalCase, cases, cfg.language, lint) : null;
      let coverageJudge: PlanRun['coverageJudge'];
      if (coverageClient && grade && hasTruth(evalCase)) {
        const verdict = await judgeMustCover(coverageClient, evalCase, cases);
        if (verdict.verdicts) grade = withCoverageVerdicts(grade, verdict.verdicts);
        coverageJudge = {
          usage: verdict.usage,
          costUsd: verdict.costUsd,
          ...(verdict.error ? { error: verdict.error } : {}),
        };
      }
      let rubric: SheetScore | undefined;
      let judge: PlanRun['judge'];
      if (judgeClient) {
        const scored = await judgeSheet(judgeClient, options.judgeModel, req.spec, cases);
        rubric = scored.score ?? undefined;
        judge = {
          model: scored.model,
          usage: scored.usage,
          costUsd: scored.costUsd,
          ...(scored.error ? { error: scored.error } : {}),
          ...(scored.attempts ? { attempts: scored.attempts } : {}),
        };
      }
      runs.push({
        caseId: evalCase.id,
        origin: evalCase.origin ?? 'synthetic',
        inputHash: inputHashOf(evalCase),
        cases,
        grade,
        ...(rubric ? { rubric } : {}),
        ...(judge ? { judge } : {}),
        usage: result.usage,
        costUsd: result.costUsd,
        calls: result.calls,
        dropped: result.dropped,
        merge: result.diagnostics,
        ...(coverageJudge ? { coverageJudge } : {}),
        warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
        seconds: (deps.now() - started) / 1000,
      });
      const merged = result.diagnostics.mergedAway.length;
      const cover = grade
        ? `, must-cover ${pct(grade.mustCoverRecallJudge ?? grade.mustCoverRecall)}${grade.mustCoverRecallJudge === undefined ? ' (kw)' : ''}`
        : '';
      const overall = rubric
        ? `, overall ${rubric.overall.toFixed(2)}`
        : judge?.error
          ? ', judge failed'
          : '';
      print(
        `  ${evalCase.id}: ${cases.length} cases${merged > 0 ? ` (${merged} merged away)` : ''}${cover}${overall} ($${result.costUsd.toFixed(2)})`,
      );
    } catch (err) {
      const e = err instanceof QtgError ? err : null;
      errors.push({
        caseId: evalCase.id,
        class: e?.code ?? 'internal',
        message: e?.userMessage ?? (err instanceof Error ? err.name : 'unknown error'),
        costUsd: provider.estimateCostUsd(e?.usage ?? ZERO),
      });
      print(`  ${evalCase.id}: no sheet (${e?.code ?? 'internal'})`);
    }
  });

  runs.sort((a, b) => a.caseId.localeCompare(b.caseId));
  errors.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const results: PlanResults = {
    kind: 'plan',
    startedAt,
    promptVersion: PLAN_PROMPT_VERSION,
    language: cfg.language,
    split: options.caseIds.length > 0 ? 'selected' : options.split,
    model: options.model,
    effort: options.effort,
    judgeModel: options.judge ? options.judgeModel : null,
    rubricVersion: options.judge ? RUBRIC_V3_VERSION : null,
    lintSource,
    runs,
    errors,
    summary: summarizePlan(runs.flatMap((r) => (r.grade ? [r.grade] : [fallbackGrade(r)]))),
    rubric: summarizeSheets(runs.flatMap((r) => (r.rubric ? [r.rubric] : []))),
    costUsd: runs.reduce((n, r) => n + r.costUsd, 0) + errors.reduce((n, e) => n + e.costUsd, 0),
    judgeCostUsd: runs.reduce((n, r) => n + (r.judge?.costUsd ?? 0) + (r.coverageJudge?.costUsd ?? 0), 0),
  };
  const resultsPath =
    options.round === null
      ? join(deps.resultsRoot, `${startedAt.replace(/[:.]/g, '-')}-plan.json`)
      : roundResultsPath(deps, options.round, cfg.language);
  deps.writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

  print('');
  print(formatPlanTable(results));
  print('');
  if (lintSource === 'fallback')
    print('Style violations were counted with the stand-in lint (the cases module is not available yet).');
  const unscored = runs
    .filter((r) => r.judge && !r.rubric)
    .map((r) => `${r.caseId} (${r.judge?.error ?? 'no score'})`);
  if (unscored.length > 0)
    print(
      `${unscored.length} sheet(s) have no rubric score and are left out of the rubric means: ${unscored.join(', ')}.`,
    );
  const mergedAway = runs.flatMap((r) =>
    (r.merge?.mergedAway ?? [])
      .filter((x) => x.by === 'merge')
      .map((x) => `${r.caseId}: "${x.title}" -> "${x.keptTitle}"${x.reason ? ` (${x.reason})` : ''}`),
  );
  if (mergedAway.length > 0) {
    print(
      `The merge call removed ${mergedAway.length} case(s) as duplicates. Check that each repeats the case it was folded into:`,
    );
    for (const line of mergedAway.slice(0, 20)) print(`  ${line}`);
    if (mergedAway.length > 20) print(`  … and ${mergedAway.length - 20} more, all in the results file`);
  }
  print(`Results written to ${resultsPath}`);
  // Last, so the recommendation is the final thing on screen.
  if (options.round !== null)
    recordRoundV3(options.round, options.change, results, formatPlanTable(results), deps);
  return { exitCode: 0, executed: true, estimateUsd, estimate, resultsPath, plan: results };
}

/** Counts for a spec without ground truth, so its sheet length and style still reach the summary. */
export function fallbackGrade(run: PlanRun): PlanGrade {
  return {
    caseId: run.caseId,
    cases: run.cases.length,
    byPriority: { P0: 0, P1: 0, P2: 0 },
    techniques: 0,
    mustCover: [],
    mustCoverRecall: 1,
    requirementsWithoutCase: [],
    requirementCoverage: 1,
    repeatedTitles: 0,
    styleViolations: 0,
    casesWithViolations: 0,
    withWhy: 0,
  };
}

export function formatVerifyTable(
  r: Pick<VerifyResults, 'model' | 'effort' | 'runs' | 'errors' | 'summary' | 'costUsd'>,
): string {
  const header = [
    'Variant',
    'PRs',
    'Errors',
    'Code status',
    'Unknown',
    'Alignment',
    'Findings',
    'New cases',
    'Cost',
  ];
  const s = r.summary;
  const graded = r.runs.some((x) => x.grade !== null);
  const row = [
    `${r.model} · ${r.effort}`,
    r.runs.length,
    r.errors.length,
    graded ? pct(s.codeStatusAccuracy) : '—',
    pct(s.unknownRate),
    graded ? pct(s.alignmentAccuracy) : '—',
    graded ? pct(s.findingRecall) : '—',
    s.newCases,
    `$${r.costUsd.toFixed(2)}`,
  ];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    `| ${row.join(' | ')} |`,
  ].join('\n');
}

/** `verify`: the cases of a saved plan run, judged against each case's pull request. */
export async function runVerifyEval(argv: string[], deps: V3Deps): Promise<V3Outcome> {
  const s = setup(argv, deps);
  if (isOutcome(s)) return s;
  const { options, missingReal } = s;
  const { print } = deps;
  if (options.from === null) {
    print('verify needs --from <plan-results.json>: the cases to judge come from a plan run.');
    print(USAGE_V3);
    return none(2);
  }
  let source: PlanResults;
  try {
    source = JSON.parse(deps.readFile(options.from)) as PlanResults;
    if (source.kind !== 'plan' || !Array.isArray(source.runs)) throw new Error('not a plan results file');
  } catch {
    print(`Cannot verify: ${options.from} is not a readable plan results file.`);
    return none(2);
  }
  // The cases were written in the plan run's language; the statuses are written in the same one.
  const configFor = (language: string): QtgConfig =>
    resolveConfig(
      (name) => (name === 'anthropic-api-key' ? 'eval' : name === 'language' ? language : ''),
      parseRepoConfig(null),
    );
  const cfg = configFor(options.language ?? source.language);

  const sheets = new Map(source.runs.map((r) => [r.caseId, r]));
  const selected = s.cases.filter((c) => sheets.has(c.id));
  const noSheet = s.cases.filter((c) => !sheets.has(c.id)).map((c) => c.id);
  const stale = selected.filter((c) => sheets.get(c.id)?.inputHash !== inputHashOf(c)).map((c) => c.id);
  const usable = selected.filter((c) => !stale.includes(c.id));
  if (usable.length === 0) {
    print(`No case in this selection has a sheet in ${options.from}.`);
    return none(2);
  }

  let engineReady = true;
  const engine = await deps.createEngine({ astLanguages: cfg.preprocess.astLanguages }).catch(() => {
    engineReady = false;
    return null;
  });
  if (!engine) {
    print('Cannot verify: the preprocess engine is not available in this checkout.');
    return none(1);
  }
  const pricing = { estimateCostUsd: (usage: LlmUsage) => estimateCostUsd(options.model, usage) };
  const guard = { maxCostUsd: cfg.maxCostUsd, expectedOutputTokens: EXPECTED_OUTPUT_TOKENS };
  const prepared = usable.map((evalCase) => {
    const pre = engine.run({
      files: evalCase.files,
      prdDocuments: evalCase.prdDocuments,
      options: { ...cfg.preprocess, ...(evalCase.options ?? {}) },
    });
    const { pr } = evalCase;
    const req: VerifyRequest = {
      spec: (pre.prdDocuments[0] ?? evalCase.prdDocuments[0]) as VerifyRequest['spec'],
      cases: (sheets.get(evalCase.id) as PlanRun).cases,
      pre,
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        htmlUrl: pr.htmlUrl,
        author: pr.author,
        baseRef: pr.baseRef,
        headRef: pr.headRef,
      },
      sha: pr.headSha,
      language: cfg.language,
      maxNewCases: MAX_NEW_CASES,
    };
    return { evalCase, pre, req, plan: pre.chunks.length === 0 ? null : planVerifyRun(req, pricing, guard) };
  });
  const estimateUsd = prepared.reduce((n, p) => n + (p.plan?.estimateUsd ?? 0), 0);
  const estimate = { runUsd: estimateUsd, judgeUsd: 0 };

  print(`Verify eval — prompt ${VERIFY_PROMPT_VERSION} (cases from plan prompt ${source.promptVersion})`);
  print(`  model: ${options.model}   effort: ${options.effort}   language: ${cfg.language}`);
  print(`  cases from: ${options.from}`);
  print(`  pull requests: ${usable.length} (${usable.filter(hasTruth).length} with ground truth)`);
  for (const p of prepared) {
    print(
      `    ${p.evalCase.id.padEnd(30)} ~$${(p.plan?.estimateUsd ?? 0).toFixed(2)}   (${p.req.cases.length} cases, ${p.pre.chunks.length} chunk(s), ${p.plan?.calls ?? 0} call(s))`,
    );
  }
  if (noSheet.length > 0) print(`  left out, no sheet in the plan results: ${noSheet.join(', ')}`);
  if (stale.length > 0) print(`  left out, the case changed after the plan run: ${stale.join(', ')}`);
  if (missingReal.length > 0)
    print(`  NOTE: ${missingReal.length} real case(s) are not on this machine and were left out.`);
  print(`  estimated run cost:   ~$${estimateUsd.toFixed(2)} (${options.model})`);
  print('  estimated judge cost: $0.00 (code statuses are graded against ground truth, without a judge)');
  if (!options.yes) {
    print('Nothing was sent to the API. Re-run with --yes to execute.');
    return { exitCode: 0, executed: false, estimateUsd, estimate };
  }
  const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || !engineReady) {
    print('Cannot execute: ANTHROPIC_API_KEY is not set.');
    return { exitCode: 1, executed: false, estimateUsd, estimate };
  }

  const provider = deps.createProvider({
    apiKey,
    model: options.model,
    effort: options.effort,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  const startedAt = new Date(deps.now()).toISOString();
  const runs: VerifyRun[] = [];
  const errors: RunErrorV3[] = [];
  await pool(prepared, options.concurrency, async ({ evalCase, pre, req }) => {
    const started = deps.now();
    try {
      const result = await verifyCases(req, provider, guard, new AbortController().signal);
      const grade = hasTruth(evalCase) ? gradeVerify(evalCase, req.cases, result) : null;
      runs.push({
        caseId: evalCase.id,
        cases: req.cases.length,
        result: { statuses: result.statuses, newCases: result.newCases, alignment: result.alignment },
        grade,
        mode: pre.mode,
        usage: result.usage,
        costUsd: result.costUsd,
        calls: result.calls,
        warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
        seconds: (deps.now() - started) / 1000,
      });
      print(
        `  ${evalCase.id}: ${grade ? `code status ${pct(grade.codeStatusAccuracy)}, ` : ''}${result.newCases.length} new case(s) ($${result.costUsd.toFixed(2)})`,
      );
    } catch (err) {
      const e = err instanceof QtgError ? err : null;
      errors.push({
        caseId: evalCase.id,
        class: e?.code ?? 'internal',
        message: e?.userMessage ?? (err instanceof Error ? err.name : 'unknown error'),
        costUsd: provider.estimateCostUsd(e?.usage ?? ZERO),
      });
      print(`  ${evalCase.id}: not judged (${e?.code ?? 'internal'})`);
    }
  });

  runs.sort((a, b) => a.caseId.localeCompare(b.caseId));
  errors.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const results: VerifyResults = {
    kind: 'verify',
    startedAt,
    promptVersion: VERIFY_PROMPT_VERSION,
    planPromptVersion: source.promptVersion,
    from: options.from,
    language: cfg.language,
    split: options.caseIds.length > 0 ? 'selected' : options.split,
    model: options.model,
    effort: options.effort,
    runs,
    errors,
    summary: summarizeVerify(runs.flatMap((r) => (r.grade ? [r.grade] : []))),
    costUsd: runs.reduce((n, r) => n + r.costUsd, 0) + errors.reduce((n, e) => n + e.costUsd, 0),
  };
  const resultsPath = join(deps.resultsRoot, `${startedAt.replace(/[:.]/g, '-')}-verify.json`);
  deps.writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  print('');
  print(formatVerifyTable(results));
  print('');
  print(`Results written to ${resultsPath}`);
  return { exitCode: 0, executed: true, estimateUsd, estimate, resultsPath, verify: results };
}
