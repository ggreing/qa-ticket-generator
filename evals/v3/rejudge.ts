/**
 * Scores the sheets of a saved plan run again. Nothing is generated.
 *
 * - `--rejudge <plan-results.json>` calls the rubric judge on every stored sheet with the rubric
 *   as it is now. Used when the rubric or the judge's instructions change, so that an earlier
 *   round gets scores a later round can be compared with. Like a run, it prints the plan and the
 *   estimated cost first and calls the API only with `--yes`.
 * - `--regrade <plan-results.json>` recomputes only what needs no model: style violations with
 *   the lint as it is now, keyword must-cover, requirements with a case. No key, no API call.
 *   Used when the lint changes.
 *
 * Both recompute the deterministic part, and both keep the must-cover verdicts the coverage judge
 * gave when the sheet was written, since neither the sheet nor the risks changed.
 *
 * Where the result goes: with `--round n`, to that round's raw file and record (its change text
 * and its keep/revert decision are kept). With `--cases`, back into the same file, because the
 * other sheets keep the scores they have. Otherwise to a new file. A file that is overwritten is
 * copied to `<file>.bak-<time>` first.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import type { Language, LlmUsage } from '../../src/core/contracts';
import type { RubricClientLike } from '../rubric';
import { type EvalCase, type GradedCase, inputHashOf, loadDataset } from '../schema';
import { gradePlan, type PlanGrade, summarizePlan, withCoverageVerdicts } from './grade';
import { recordRoundV3, roundResultsPath } from './rounds';
import { estimateJudgeCost, judgeSheet, RUBRIC_V3_VERSION, summarizeSheets } from './rubric';
import {
  fallbackGrade,
  formatPlanTable,
  type PlanResults,
  type PlanRun,
  resolveLint,
  type V3Deps,
  type V3Options,
  type V3Outcome,
} from './run';

type Skip = 'unknown_case' | 'stale' | 'empty';
const SKIP_TEXT: Readonly<Record<Skip, string>> = {
  unknown_case: 'no such eval case any more',
  stale: 'the spec changed since the sheet was written',
  empty: 'the sheet has no cases',
};

const hasTruth = (c: EvalCase): c is GradedCase => c.expected !== null;
const none = (exitCode: number): V3Outcome => ({ exitCode, executed: false, estimateUsd: 0 });

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await worker(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function skipReason(run: PlanRun, evalCase: EvalCase | undefined): Skip | null {
  if (!evalCase || evalCase.prdDocuments.length === 0) return 'unknown_case';
  // The judge reads the spec; after an edit it is not what the sheet was written for.
  if (run.inputHash !== inputHashOf(evalCase)) return 'stale';
  if (run.cases.length === 0) return 'empty';
  return null;
}

/**
 * The deterministic grade of a stored sheet, computed again. The coverage judge's verdicts are
 * carried over when the checklist of risks is the one they were given for.
 */
export function regradeRun(
  run: PlanRun,
  evalCase: EvalCase,
  language: Language,
  lint: Parameters<typeof gradePlan>[3],
): { grade: PlanGrade | null; verdictsDropped: boolean } {
  if (!hasTruth(evalCase)) return { grade: null, verdictsDropped: false };
  const grade = gradePlan(evalCase, run.cases, language, lint);
  const old = run.grade;
  if (!old || old.mustCoverRecallJudge === undefined) return { grade, verdictsDropped: false };
  const before = old.mustCover.map((m) => m.id).sort();
  const now = grade.mustCover.map((m) => m.id).sort();
  if (before.length !== now.length || before.some((id, i) => id !== now[i]))
    return { grade, verdictsDropped: true };
  return {
    grade: withCoverageVerdicts(
      grade,
      Object.fromEntries(old.mustCover.map((m) => [m.id, m.judgeCase ?? null])),
    ),
    verdictsDropped: false,
  };
}

export async function rescorePlan(
  path: string,
  mode: 'rejudge' | 'regrade',
  options: V3Options,
  deps: V3Deps,
): Promise<V3Outcome> {
  const { print } = deps;
  const verb = mode === 'rejudge' ? 're-judge' : 'regrade';
  let saved: PlanResults;
  let original: string;
  try {
    original = deps.readFile(path);
    saved = JSON.parse(original) as PlanResults;
    if (saved.kind !== 'plan' || !Array.isArray(saved.runs)) throw new Error('not plan results');
  } catch {
    print(`Cannot ${verb}: ${path} is not a readable plan results file.`);
    return none(2);
  }
  const absent = options.caseIds.filter((id) => !saved.runs.some((r) => r.caseId === id));
  if (absent.length > 0) {
    print(`Cannot ${verb}: ${path} has no sheet for ${absent.join(', ')}.`);
    return none(2);
  }
  const partial = options.caseIds.length > 0;
  if (mode === 'rejudge' && partial && saved.rubricVersion !== RUBRIC_V3_VERSION) {
    // The other sheets would keep scores given under another rubric; their mean would mean nothing.
    print(
      `Cannot re-judge part of ${path}: it was scored with rubric v${saved.rubricVersion ?? '?'} and the rubric is now v${RUBRIC_V3_VERSION}. Re-judge the whole file (drop --cases).`,
    );
    return none(2);
  }

  const byId = new Map(loadDataset(deps.evalsRoot).cases.map((c) => [c.id, c]));
  const skipped: Record<Skip, string[]> = { unknown_case: [], stale: [], empty: [] };
  const jobs: { run: PlanRun; evalCase: EvalCase }[] = [];
  for (const run of saved.runs) {
    if (partial && !options.caseIds.includes(run.caseId)) continue;
    const evalCase = byId.get(run.caseId);
    const reason = skipReason(run, evalCase);
    if (reason) skipped[reason].push(run.caseId);
    else jobs.push({ run, evalCase: evalCase as EvalCase });
  }

  const model = options.judgeModel;
  const estimateUsd =
    mode === 'rejudge'
      ? jobs.reduce(
          (n, j) => n + estimateJudgeCost(model, j.evalCase.prdDocuments[0] as never, j.run.cases.length),
          0,
        )
      : 0;
  const estimate = { runUsd: 0, judgeUsd: estimateUsd };
  const outPath =
    options.round !== null
      ? roundResultsPath(deps, options.round, saved.language)
      : partial
        ? path
        : join(
            deps.resultsRoot,
            `${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}-plan-${mode === 'rejudge' ? 'rejudged' : 'regraded'}.json`,
          );
  // Whatever is at the destination is kept as a copy before it is replaced.
  let existing: string | null = null;
  try {
    existing = deps.readFile(outPath);
  } catch {
    existing = null;
  }
  print(
    mode === 'rejudge'
      ? `Re-judge plan — rubric v${RUBRIC_V3_VERSION} (the file was scored with ${saved.rubricVersion === null ? 'no rubric judge' : `rubric v${saved.rubricVersion}`})`
      : 'Regrade plan — deterministic metrics only (style lint, keyword must-cover, requirements with a case)',
  );
  print(
    `  source: ${path}   prompt ${saved.promptVersion}   language: ${saved.language}   sheets: ${jobs.length} of ${saved.runs.length}`,
  );
  if (mode === 'rejudge') print(`  judge model: ${model}`);
  for (const reason of Object.keys(skipped) as Skip[]) {
    if (skipped[reason].length > 0) print(`  left out, ${SKIP_TEXT[reason]}: ${skipped[reason].join(', ')}`);
  }
  print('  estimated run cost:   $0.00 (no sheet is generated)');
  print(
    mode === 'rejudge'
      ? `  estimated judge cost: ~$${estimateUsd.toFixed(2)} (${model} rubric judge; the must-cover verdicts are kept)`
      : '  estimated judge cost: $0.00 (no model is called)',
  );
  print(`  estimated total:      ~$${estimateUsd.toFixed(2)}`);
  print(
    existing === null
      ? `  result goes to ${outPath}`
      : `  ${outPath} is replaced; what it holds now is copied to ${outPath}.bak-<time> first`,
  );
  if (jobs.length === 0) {
    print(`Nothing to ${verb}.`);
    return { ...none(2), estimate };
  }
  let judgeClient: RubricClientLike | null = null;
  if (mode === 'rejudge') {
    if (!options.yes) {
      print('Nothing was sent to the API. Re-run with --yes to execute.');
      return { exitCode: 0, executed: false, estimateUsd, estimate };
    }
    const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      print('Cannot execute: ANTHROPIC_API_KEY is not set.');
      return { exitCode: 1, executed: false, estimateUsd, estimate };
    }
    judgeClient = deps.createRubricClient(apiKey);
  }

  const { lint, source: lintSource } = resolveLint(deps);
  const language = saved.language as Language;
  const next = new Map<string, PlanRun>();
  const lostVerdicts: string[] = [];
  let spentUsd = 0;
  await pool(jobs, options.concurrency, async ({ run, evalCase }) => {
    const { grade, verdictsDropped } = regradeRun(run, evalCase, language, lint);
    if (verdictsDropped) lostVerdicts.push(run.caseId);
    const { rubric: _rubric, judge: _judge, ...rest } = run;
    let updated: PlanRun = { ...rest, grade, ...(run.rubric ? { rubric: run.rubric } : {}) };
    if (run.judge) updated.judge = run.judge;
    if (judgeClient) {
      const scored = await judgeSheet(judgeClient, model, evalCase.prdDocuments[0] as never, run.cases);
      spentUsd += scored.costUsd;
      // A sheet the judge could not score loses its old score too: it was given under another rubric.
      updated = {
        ...rest,
        grade,
        ...(scored.score ? { rubric: scored.score } : {}),
        judge: {
          model: scored.model,
          usage: scored.usage as LlmUsage,
          costUsd: scored.costUsd,
          ...(scored.error ? { error: scored.error } : {}),
          ...(scored.attempts ? { attempts: scored.attempts } : {}),
        },
      };
      print(
        `  ${run.caseId}: ${scored.score ? `overall ${scored.score.overall.toFixed(2)}${run.rubric ? ` (was ${run.rubric.overall.toFixed(2)})` : ''}` : `no score (${scored.error ?? 'judge incomplete'})`}`,
      );
    }
    next.set(run.caseId, updated);
  });

  // A whole-file re-judge leaves no score from the old rubric behind, not even on a skipped sheet.
  const dropOld = mode === 'rejudge' && !partial;
  const runs = saved.runs.map((run): PlanRun => {
    const updated = next.get(run.caseId);
    if (updated) return updated;
    if (!dropOld) return run;
    const { rubric: _rubric, judge: _judge, ...rest } = run;
    return rest;
  });
  const results: PlanResults = {
    ...saved,
    ...(mode === 'rejudge' ? { judgeModel: model, rubricVersion: RUBRIC_V3_VERSION } : {}),
    lintSource,
    runs,
    summary: summarizePlan(runs.flatMap((r) => (r.grade ? [r.grade] : [fallbackGrade(r)]))),
    rubric: summarizeSheets(runs.flatMap((r) => (r.rubric ? [r.rubric] : []))),
    judgeCostUsd: runs.reduce((n, r) => n + (r.judge?.costUsd ?? 0) + (r.coverageJudge?.costUsd ?? 0), 0),
  };

  const stamp = new Date(deps.now()).toISOString();
  if (existing !== null) deps.writeFile(`${outPath}.bak-${stamp.replace(/[:.]/g, '-')}`, existing);
  deps.writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`);

  const table = formatPlanTable(results);
  print('');
  print(table);
  print('');
  if (mode === 'rejudge') print(`The re-judge cost $${spentUsd.toFixed(2)}.`);
  const unscored = runs
    .filter((r) => r.judge && !r.rubric)
    .map((r) => `${r.caseId} (${r.judge?.error ?? 'no score'})`);
  if (unscored.length > 0)
    print(
      `${unscored.length} sheet(s) have no rubric score and are left out of the rubric means: ${unscored.join(', ')}.`,
    );
  if (lostVerdicts.length > 0)
    print(
      `The must-cover checklist changed for ${lostVerdicts.join(', ')}; the coverage judge's verdicts no longer apply there and only the keyword figure is left. Run the sheet again to get them back.`,
    );
  print(`Results written to ${outPath}`);
  if (options.round !== null) {
    recordRoundV3(options.round, options.change, results, table, deps, {
      at: stamp,
      what: mode === 'rejudge' ? 'judge' : 'deterministic',
    });
  }
  return {
    exitCode: 0,
    executed: mode === 'rejudge',
    estimateUsd,
    estimate,
    resultsPath: outPath,
    plan: results,
  };
}
