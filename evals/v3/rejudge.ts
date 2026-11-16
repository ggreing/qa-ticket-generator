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
 * - `--regrade-coverage <plan-results.json>` asks the coverage judge which case tests each of the
 *   spec's second-order combinations (`expected.secondOrder`). Used when that list is added or
 *   changed, so stored rounds get a recall figure without being written again. A small model and
 *   one call per sheet; it still prints the cost first and needs `--yes`.
 *
 * All three recompute the deterministic part and keep the verdicts the coverage judge gave earlier
 * wherever the checklist they were given for has not changed.
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
import { COVERAGE_MODEL, estimateCoverageCost, judgeChecklist } from './coverage';
import {
  gradePlan,
  type PlanGrade,
  summarizePlan,
  withCoverageVerdicts,
  withSecondOrderVerdicts,
} from './grade';
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

export type RescoreMode = 'rejudge' | 'regrade' | 'coverage';

type Skip = 'unknown_case' | 'stale' | 'empty';
const SKIP_TEXT: Readonly<Record<Skip, string>> = {
  unknown_case: 'no such eval case any more',
  stale: 'the spec changed since the sheet was written',
  empty: 'the sheet has no cases',
};
const VERB: Readonly<Record<RescoreMode, string>> = {
  rejudge: 're-judge',
  regrade: 'regrade',
  coverage: 'regrade the coverage of',
};
const SUFFIX: Readonly<Record<RescoreMode, string>> = {
  rejudge: 'rejudged',
  regrade: 'regraded',
  coverage: 'coverage',
};

const hasTruth = (c: EvalCase): c is GradedCase => c.expected !== null;
const none = (exitCode: number): V3Outcome => ({ exitCode, executed: false, estimateUsd: 0 });
const sameIds = (a: string[], b: string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

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
 * carried over when the checklist they were given for is still the one in `expected.json`: the
 * must-cover risks and the second-order combinations each on their own.
 */
export function regradeRun(
  run: PlanRun,
  evalCase: EvalCase,
  language: Language,
  lint: Parameters<typeof gradePlan>[3],
): { grade: PlanGrade | null; verdictsDropped: boolean; secondOrderDropped: boolean } {
  if (!hasTruth(evalCase)) return { grade: null, verdictsDropped: false, secondOrderDropped: false };
  let grade = gradePlan(evalCase, run.cases, language, lint);
  const old = run.grade;
  let verdictsDropped = false;
  let secondOrderDropped = false;
  if (old && old.mustCoverRecallJudge !== undefined) {
    if (
      sameIds(
        old.mustCover.map((m) => m.id),
        grade.mustCover.map((m) => m.id),
      )
    ) {
      grade = withCoverageVerdicts(
        grade,
        Object.fromEntries(old.mustCover.map((m) => [m.id, m.judgeCase ?? null])),
      );
    } else verdictsDropped = true;
  }
  if (old?.secondOrder) {
    const ids = (evalCase.expected.secondOrder ?? []).map((s) => s.id);
    if (
      sameIds(
        old.secondOrder.map((s) => s.id),
        ids,
      )
    ) {
      grade = withSecondOrderVerdicts(
        grade,
        ids,
        Object.fromEntries(old.secondOrder.map((s) => [s.id, s.judgeCase])),
      );
    } else secondOrderDropped = true;
  }
  return { grade, verdictsDropped, secondOrderDropped };
}

export async function rescorePlan(
  path: string,
  mode: RescoreMode,
  options: V3Options,
  deps: V3Deps,
): Promise<V3Outcome> {
  const { print } = deps;
  const verb = VERB[mode];
  let saved: PlanResults;
  try {
    saved = JSON.parse(deps.readFile(path)) as PlanResults;
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
  /** The second-order combinations of a job's spec; empty when it has no such list. */
  const listOf = (evalCase: EvalCase): { id: string; risk: string }[] =>
    hasTruth(evalCase) ? (evalCase.expected.secondOrder ?? []) : [];
  const withList = jobs.filter((j) => listOf(j.evalCase).length > 0);
  const noList = jobs.filter((j) => listOf(j.evalCase).length === 0).map((j) => j.run.caseId);

  const model = options.judgeModel;
  const estimateUsd =
    mode === 'rejudge'
      ? jobs.reduce(
          (n, j) => n + estimateJudgeCost(model, j.evalCase.prdDocuments[0] as never, j.run.cases.length),
          0,
        )
      : mode === 'coverage'
        ? withList.reduce(
            (n, j) => n + estimateCoverageCost(j.run.cases.length, listOf(j.evalCase).length),
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
            `${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}-plan-${SUFFIX[mode]}.json`,
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
      : mode === 'coverage'
        ? 'Regrade coverage — which case tests each second-order combination of the spec (expected.secondOrder)'
        : 'Regrade plan — deterministic metrics only (style lint, keyword must-cover, requirements with a case)',
  );
  print(
    `  source: ${path}   prompt ${saved.promptVersion}   language: ${saved.language}   sheets: ${(mode === 'coverage' ? withList : jobs).length} of ${saved.runs.length}`,
  );
  if (mode === 'rejudge') print(`  judge model: ${model}`);
  for (const reason of Object.keys(skipped) as Skip[]) {
    if (skipped[reason].length > 0) print(`  left out, ${SKIP_TEXT[reason]}: ${skipped[reason].join(', ')}`);
  }
  if (mode === 'coverage' && noList.length > 0)
    print(`  left out, no second-order list in expected.json: ${noList.join(', ')}`);
  print('  estimated run cost:   $0.00 (no sheet is generated)');
  print(
    mode === 'rejudge'
      ? `  estimated judge cost: ~$${estimateUsd.toFixed(2)} (${model} rubric judge; the must-cover verdicts are kept)`
      : mode === 'coverage'
        ? `  estimated judge cost: ~$${estimateUsd.toFixed(2)} (${COVERAGE_MODEL}, ${withList.reduce((n, j) => n + listOf(j.evalCase).length, 0)} combinations; rubric scores and must-cover verdicts are kept)`
        : '  estimated judge cost: $0.00 (no model is called)',
  );
  print(`  estimated total:      ~$${estimateUsd.toFixed(2)}`);
  print(
    existing === null
      ? `  result goes to ${outPath}`
      : `  ${outPath} is replaced; what it holds now is copied to ${outPath}.bak-<time> first`,
  );
  if ((mode === 'coverage' ? withList : jobs).length === 0) {
    print(
      mode === 'coverage' && jobs.length > 0
        ? 'Nothing to regrade: none of these specs has a second-order list yet.'
        : `Nothing to ${verb}.`,
    );
    return { ...none(2), estimate };
  }
  let client: RubricClientLike | null = null;
  if (mode !== 'regrade') {
    if (!options.yes) {
      print('Nothing was sent to the API. Re-run with --yes to execute.');
      return { exitCode: 0, executed: false, estimateUsd, estimate };
    }
    const apiKey = deps.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      print('Cannot execute: ANTHROPIC_API_KEY is not set.');
      return { exitCode: 1, executed: false, estimateUsd, estimate };
    }
    client = deps.createRubricClient(apiKey);
  }

  const { lint, source: lintSource } = resolveLint(deps);
  const language = saved.language as Language;
  const next = new Map<string, PlanRun>();
  const lostVerdicts: string[] = [];
  const lostSecondOrder: string[] = [];
  const failedCoverage: string[] = [];
  let spentUsd = 0;
  await pool(jobs, options.concurrency, async ({ run, evalCase }) => {
    const regraded = regradeRun(run, evalCase, language, lint);
    let { grade } = regraded;
    if (regraded.verdictsDropped) lostVerdicts.push(run.caseId);
    const { rubric: _rubric, judge: _judge, ...rest } = run;
    let updated: PlanRun = { ...rest, grade, ...(run.rubric ? { rubric: run.rubric } : {}) };
    if (run.judge) updated.judge = run.judge;

    if (mode === 'coverage' && client && grade && listOf(evalCase).length > 0) {
      const list = listOf(evalCase);
      const verdict = await judgeChecklist(client, list, run.cases);
      spentUsd += verdict.costUsd;
      if (verdict.verdicts) {
        grade = withSecondOrderVerdicts(
          grade,
          list.map((s) => s.id),
          verdict.verdicts,
        );
        print(
          `  ${run.caseId}: ${grade.secondOrder?.filter((s) => s.judgeCase !== null).length} of ${list.length} combinations have a case`,
        );
      } else {
        failedCoverage.push(`${run.caseId} (${verdict.error ?? 'no verdicts'})`);
        print(`  ${run.caseId}: no verdicts (${verdict.error ?? 'coverage judge failed'})`);
      }
      updated = {
        ...updated,
        grade,
        secondOrderJudge: {
          usage: verdict.usage,
          costUsd: verdict.costUsd,
          ...(verdict.error ? { error: verdict.error } : {}),
        },
      };
    } else if (regraded.secondOrderDropped) lostSecondOrder.push(run.caseId);

    if (mode === 'rejudge' && client) {
      const scored = await judgeSheet(client, model, evalCase.prdDocuments[0] as never, run.cases);
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
    judgeCostUsd: runs.reduce(
      (n, r) =>
        n + (r.judge?.costUsd ?? 0) + (r.coverageJudge?.costUsd ?? 0) + (r.secondOrderJudge?.costUsd ?? 0),
      0,
    ),
  };

  const stamp = new Date(deps.now()).toISOString();
  if (existing !== null) deps.writeFile(`${outPath}.bak-${stamp.replace(/[:.]/g, '-')}`, existing);
  deps.writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`);

  const table = formatPlanTable(results);
  print('');
  print(table);
  print('');
  if (mode === 'rejudge') print(`The re-judge cost $${spentUsd.toFixed(2)}.`);
  if (mode === 'coverage') {
    const s = results.summary;
    print(
      `Second-order recall: ${s.secondOrderRecall === null ? 'no sheet was checked' : `${(s.secondOrderRecall * 100).toFixed(0)}% of ${s.secondOrderItems} combinations`}. The check cost $${spentUsd.toFixed(3)}.`,
    );
    if (failedCoverage.length > 0)
      print(`No verdicts for ${failedCoverage.join(', ')}; those sheets are left out of the recall.`);
  }
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
  if (lostSecondOrder.length > 0)
    print(
      `The second-order list changed for ${lostSecondOrder.join(', ')}; the earlier verdicts no longer apply there. Run plan --regrade-coverage on this file to get them back.`,
    );
  print(`Results written to ${outPath}`);
  if (options.round !== null) {
    recordRoundV3(options.round, options.change, results, table, deps, {
      at: stamp,
      what: mode === 'rejudge' ? 'judge' : mode === 'coverage' ? 'coverage' : 'deterministic',
    });
  }
  return {
    exitCode: 0,
    executed: mode !== 'regrade',
    estimateUsd,
    estimate,
    resultsPath: outPath,
    plan: results,
  };
}

/** One sheet judged twice: how far the two judgings are apart. */
export interface JudgingDiff {
  sheets: number;
  /** Overall of each judging over the sheets both scored, and the difference of the means. */
  overall: { a: number; b: number; diff: number };
  /** Mean absolute difference of a sheet's overall between the two judgings. */
  meanAbsSheetDiff: number;
  /** Largest difference of one sheet's overall. */
  maxSheetDiff: number;
  /** Per sheet-level criterion: how many sheets got a different score. */
  moved: Record<string, number>;
}

/**
 * Compares two judgings of the same sheets, to see how much the rubric judge moves between two
 * readings of identical input. A difference between rounds that is no larger than this is noise.
 */
export function diffJudgings(a: PlanResults, b: PlanResults): JudgingDiff | null {
  const pairs = a.runs.flatMap((ra) => {
    const rb = b.runs.find((r) => r.caseId === ra.caseId);
    return ra.rubric && rb?.rubric ? [{ a: ra.rubric, b: rb.rubric }] : [];
  });
  if (pairs.length === 0) return null;
  const mean = (values: number[]): number => values.reduce((x, y) => x + y, 0) / values.length;
  const diffs = pairs.map((p) => Math.abs(p.a.overall - p.b.overall));
  const overallA = mean(pairs.map((p) => p.a.overall));
  const overallB = mean(pairs.map((p) => p.b.overall));
  const moved: Record<string, number> = {};
  for (const key of ['coverage', 'noDuplicates', 'honesty'] as const)
    moved[key] = pairs.filter((p) => p.a.sheet[key] !== p.b.sheet[key]).length;
  return {
    sheets: pairs.length,
    overall: { a: overallA, b: overallB, diff: overallB - overallA },
    meanAbsSheetDiff: mean(diffs),
    maxSheetDiff: Math.max(...diffs),
    moved,
  };
}

/** `plan --judge-noise <a.json> <b.json>`: offline report of {@link diffJudgings}. */
export function reportJudgeNoise(pathA: string, pathB: string, deps: V3Deps): number {
  const read = (path: string): PlanResults | null => {
    try {
      const r = JSON.parse(deps.readFile(path)) as PlanResults;
      return r.kind === 'plan' && Array.isArray(r.runs) ? r : null;
    } catch {
      return null;
    }
  };
  const a = read(pathA);
  const b = read(pathB);
  if (!a || !b) {
    deps.print(`Cannot compare: ${!a ? pathA : pathB} is not a readable plan results file.`);
    return 2;
  }
  if (a.rubricVersion !== b.rubricVersion) {
    deps.print(
      `Cannot compare: the files were judged with rubric v${a.rubricVersion ?? '?'} and v${b.rubricVersion ?? '?'}. Judge noise is the difference between two judgings under the same rubric.`,
    );
    return 2;
  }
  const sameSheets = a.runs.every((ra) => {
    const rb = b.runs.find((r) => r.caseId === ra.caseId);
    return !rb || JSON.stringify(rb.cases) === JSON.stringify(ra.cases);
  });
  if (!sameSheets) {
    deps.print(
      'Cannot compare: the two files do not hold the same sheets. Judge noise is measured on identical sheets; re-judge one file twice (plan --rejudge without --round writes a new file each time).',
    );
    return 2;
  }
  const d = diffJudgings(a, b);
  if (!d) {
    deps.print('Cannot compare: no sheet has a rubric score in both files.');
    return 2;
  }
  deps.print(`Judge noise — two judgings of the same ${d.sheets} sheets under rubric v${a.rubricVersion}`);
  deps.print(
    `  overall: ${d.overall.a.toFixed(2)} and ${d.overall.b.toFixed(2)} (difference ${d.overall.diff >= 0 ? '+' : ''}${d.overall.diff.toFixed(2)})`,
  );
  deps.print(
    `  per sheet: the overall differs by ${d.meanAbsSheetDiff.toFixed(2)} on average, ${d.maxSheetDiff.toFixed(2)} at most`,
  );
  deps.print(
    `  sheets whose score changed: spec coverage ${d.moved.coverage}, no duplicates ${d.moved.noDuplicates}, honesty ${d.moved.honesty} (of ${d.sheets})`,
  );
  deps.print(
    `A difference in the overall between two rounds that is not clearly larger than ${Math.abs(d.overall.diff).toFixed(2)} cannot be told from the judge reading the same sheets twice.`,
  );
  return 0;
}
