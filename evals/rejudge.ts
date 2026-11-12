/**
 * Re-judge: scores the reports of a saved run again with the current rubric. Nothing is generated;
 * only the rubric judge is called, so it costs a fraction of a run. Used when the rubric changes,
 * to give an earlier round scores that later rounds can be compared with.
 *
 * Like a run, it prints the plan and the estimated cost first and calls the API only with `--yes`.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import type { LlmUsage } from '../src/core/contracts';
import { estimateCostUsd } from '../src/llm/pricing';
import { formatSummaryTable } from './grade';
import { recordRejudgedRound } from './rounds';
import {
  buildRubricInput,
  JUDGE_OUTPUT_BASE_TOKENS,
  JUDGE_OUTPUT_TOKENS_PER_TICKET,
  judgeWithRubric,
  RUBRIC_SYSTEM,
  RUBRIC_VERSION,
  type RubricScore,
  summarizeRubric,
} from './rubric';
import type { RunDeps, RunOptions, RunOutcome, RunRecord, SavedResults, VariantResult } from './run';
import { type EvalCase, inputHashOf } from './schema';

/** Characters per token used to size the judge input; the same rough ratio the preprocess estimate uses. */
const CHARS_PER_TOKEN = 3.2;
const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

type Skip = 'unknown_case' | 'stale' | 'no_comment';

interface Job {
  variant: number;
  index: number;
  run: RunRecord;
  evalCase: EvalCase;
  comment: string;
}

/** Why a stored run cannot be judged again, or null when it can. */
function skipReason(run: RunRecord, evalCase: EvalCase | undefined): Skip | null {
  if (!evalCase) return 'unknown_case';
  // The judge reads the case's PRD and diff; after an edit they are not what the report was written for.
  if (run.inputHash !== undefined && run.inputHash !== inputHashOf(evalCase)) return 'stale';
  if (!run.comment) return 'no_comment';
  return null;
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await worker(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** `--rejudge <results.json> [--round <n>]`. */
export async function rejudgeResults(
  path: string,
  cases: EvalCase[],
  options: RunOptions,
  deps: RunDeps,
): Promise<RunOutcome> {
  const { print } = deps;
  let saved: SavedResults;
  try {
    saved = JSON.parse(deps.readFile(path)) as SavedResults;
    if (!Array.isArray(saved.variants)) throw new Error('no variants');
  } catch {
    print(`Cannot re-judge: ${path} is not a readable eval results file.`);
    return { exitCode: 2, executed: false, estimateUsd: 0 };
  }

  const byId = new Map(cases.map((c) => [c.id, c]));
  const jobs: Job[] = [];
  const skipped: Record<Skip, string[]> = { unknown_case: [], stale: [], no_comment: [] };
  saved.variants.forEach((variant, v) => {
    variant.runs.forEach((run, index) => {
      const evalCase = byId.get(run.caseId);
      const reason = skipReason(run, evalCase);
      if (reason) skipped[reason].push(`${run.caseId}#${run.rep + 1}`);
      else
        jobs.push({ variant: v, index, run, evalCase: evalCase as EvalCase, comment: run.comment as string });
    });
  });

  // ── plan and estimated cost ─────────────────────────────────────────────────
  const model = options.judgeModel;
  const estimateUsd = jobs.reduce((sum, job) => {
    const input = RUBRIC_SYSTEM.length + buildRubricInput(job.evalCase, job.run.report, job.comment).length;
    return (
      sum +
      estimateCostUsd(model, {
        ...ZERO,
        inputTokens: Math.ceil(input / CHARS_PER_TOKEN),
        outputTokens:
          JUDGE_OUTPUT_BASE_TOKENS + JUDGE_OUTPUT_TOKENS_PER_TICKET * job.run.report.scenarios.length,
      })
    );
  }, 0);
  const estimate = { runUsd: 0, judgeUsd: estimateUsd };

  print(`Re-judge plan — rubric v${RUBRIC_VERSION}`);
  print(`  source: ${path} (prompt ${saved.promptVersion ?? 'unknown'}, split ${saved.split ?? 'unknown'})`);
  print(`  judge model: ${model}`);
  print(`  reports to judge: ${jobs.length}`);
  const notes: [Skip, string][] = [
    ['stale', "the case's PR, files or PRD changed after the run"],
    ['unknown_case', 'no such case on this machine'],
    ['no_comment', 'the run did not store the rendered comment'],
  ];
  for (const [reason, why] of notes) {
    if (skipped[reason].length > 0) {
      print(`  left out, ${why}: ${skipped[reason].join(', ')}`);
    }
  }
  print('  estimated run cost:   $0.00 (no report is generated)');
  print(`  estimated judge cost: ~$${estimateUsd.toFixed(2)} (${model} rubric judge)`);
  print(`  estimated total:      ~$${estimateUsd.toFixed(2)}`);
  if (options.round !== null) {
    print(`  the scores are recorded for round ${options.round} beside its existing record`);
  }

  if (jobs.length === 0) {
    print('Nothing to judge.');
    return { exitCode: 2, executed: false, estimateUsd: 0, estimate };
  }
  if (!options.yes) {
    print('Nothing was sent to the API. Re-run with --yes to execute.');
    return { exitCode: 0, executed: false, estimateUsd, estimate };
  }
  const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    print('Cannot execute: ANTHROPIC_API_KEY is not set.');
    return { exitCode: 1, executed: false, estimateUsd, estimate };
  }

  // ── judge ───────────────────────────────────────────────────────────────────
  const client = deps.createRubricClient(apiKey);
  const startedAt = new Date(deps.now()).toISOString();
  // Old scores never travel into the new file: a run that is not judged again has no rubric score.
  const variants: VariantResult[] = saved.variants.map((variant) => ({
    ...variant,
    runs: variant.runs.map(({ rubric: _old, rubricJudge: _oldJudge, ...run }) => run),
  }));
  await pool(jobs, options.concurrency, async (job) => {
    const scored = await judgeWithRubric(
      client,
      model,
      job.evalCase,
      job.run.report,
      job.comment,
      job.run.grade ?? null,
    );
    const runs = (variants[job.variant] as VariantResult).runs;
    runs[job.index] = {
      ...(runs[job.index] as RunRecord),
      ...(scored.score ? { rubric: scored.score } : {}),
      rubricJudge: {
        model: scored.model,
        usage: scored.usage,
        costUsd: scored.costUsd,
        ...(scored.error ? { error: scored.error } : {}),
      },
    };
    const name = `${job.run.caseId}#${job.run.rep + 1}`;
    print(
      scored.score
        ? `  ${name}: overall ${scored.score.overall.toFixed(2)}, coverage ${scored.score.report.coverage ?? '—'}`
        : `  ${name}: judge failed (${scored.error ?? 'unknown'})`,
    );
  });

  for (const variant of variants) {
    const scores = variant.runs.flatMap((r): RubricScore[] => (r.rubric ? [r.rubric] : []));
    variant.rubric = summarizeRubric(scores);
    // What this file's scores cost: the re-judge, plus any coverage-judge verdicts carried over.
    variant.judgeCostUsd = variant.runs.reduce(
      (n, r) => n + (r.judge?.costUsd ?? 0) + (r.rubricJudge?.costUsd ?? 0),
      0,
    );
  }

  const result: SavedResults = {
    ...saved,
    judgeModel: model,
    rubricVersion: RUBRIC_VERSION,
    rejudgedFrom: path,
    rejudgedAt: startedAt,
    estimateUsd,
    variants,
  };
  const table = formatSummaryTable(
    variants.map((v) => ({
      label: v.label,
      runs: v.runs.length,
      summary: v.summary,
      rubric: v.rubric,
      costUsd: v.costUsd,
      judgeCostUsd: v.judgeCostUsd,
      avgSeconds: v.runs.length > 0 ? v.runs.reduce((n, r) => n + r.seconds, 0) / v.runs.length : 0,
    })),
  );
  const resultsPath =
    options.round === null
      ? join(deps.resultsRoot, `${startedAt.replace(/[:.]/g, '-')}-rejudged.json`)
      : join(
          deps.evalsRoot,
          'rounds',
          String(options.round),
          'raw',
          `results.rubric-v${RUBRIC_VERSION}.json`,
        );
  deps.writeFile(resultsPath, `${JSON.stringify(result, null, 2)}\n`);

  print('');
  print(table);
  print('');
  print(`Re-judged results written to ${resultsPath}`);
  const failed = variants.reduce((n, v) => n + v.runs.filter((r) => r.rubricJudge?.error).length, 0);
  if (failed > 0)
    print(`${failed} report(s) have no score because the judge failed; run --rejudge again to retry.`);
  if (options.round !== null) recordRejudgedRound(options.round, result, table, deps);
  return { exitCode: 0, executed: true, estimateUsd, estimate, resultsPath, variants };
}
