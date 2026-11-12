/**
 * Offline re-grade: applies the current cases and grading rules to the reports stored in a saved
 * results file. No API call. Use it after changing `expected.json` or the grader to see what the
 * change does to an existing run, without paying for a new one.
 *
 * A stored report only says something about the inputs it was written for. When a case's PR,
 * files or PRD were edited after the run, that run is reported as stale and left out of the
 * re-graded numbers; only a new run can grade the edited case.
 * Owner: qa-work-session-c(fable).
 */
import { type CaseGrade, formatSummaryTable, gradeCase, summarize, withJudgeVerdicts } from './grade';
import type { RunDeps, RunOutcome, RunRecord, VariantResult } from './run';
import { type EvalCase, inputHashOf } from './schema';

export interface RegradedRun {
  caseId: string;
  rep: number;
  /** `stale`: inputs changed since the run. `unknown_case`: the case no longer exists. */
  status: 'regraded' | 'stale' | 'unknown_case';
  before: boolean;
  after: boolean | null;
  grade: CaseGrade | null;
}

export interface RegradedVariant {
  label: string;
  runs: RegradedRun[];
}

interface SavedResults {
  variants: Pick<VariantResult, 'label' | 'runs' | 'errors' | 'costUsd' | 'judgeCostUsd'>[];
}

function regradeRun(run: RunRecord, evalCase: EvalCase | undefined, editedIds: string[]): RegradedRun {
  const base = { caseId: run.caseId, rep: run.rep, before: run.grade.pass };
  if (!evalCase) return { ...base, status: 'unknown_case', after: null, grade: null };
  const hashChanged = run.inputHash !== undefined && run.inputHash !== inputHashOf(evalCase);
  if (hashChanged || editedIds.includes(run.caseId)) {
    return { ...base, status: 'stale', after: null, grade: null };
  }
  let grade = gradeCase(evalCase, { report: run.report, raw: run.raw ?? run.report });
  // Judge verdicts were paid for once; carry them over for the risks that still exist.
  const judged = run.grade.scenarios.filter((s) => s.judgeHit !== undefined);
  if (judged.length > 0) {
    grade = withJudgeVerdicts(grade, Object.fromEntries(judged.map((s) => [s.id, s.judgeHit === true])));
  }
  return { ...base, status: 'regraded', after: grade.pass, grade };
}

/** Re-grades `path` against `cases` and prints what changed. Reads one file, writes nothing. */
export function regradeResults(
  path: string,
  cases: EvalCase[],
  deps: RunDeps,
  /** Cases known to have been edited since the run, for files that carry no input hashes. */
  editedIds: string[] = [],
): RunOutcome {
  const { print } = deps;
  let saved: SavedResults;
  try {
    saved = JSON.parse(deps.readFile(path)) as SavedResults;
    if (!Array.isArray(saved.variants)) throw new Error('no variants');
  } catch {
    print(`Cannot re-grade: ${path} is not a readable eval results file.`);
    return { exitCode: 2, executed: false, estimateUsd: 0 };
  }

  const byId = new Map(cases.map((c) => [c.id, c]));
  const regraded: RegradedVariant[] = saved.variants.map((variant) => ({
    label: variant.label,
    runs: variant.runs.map((run) => regradeRun(run, byId.get(run.caseId), editedIds)),
  }));

  print(`Re-grade of ${path} (no API call)`);
  const withoutHash = saved.variants.some((v) => v.runs.some((r) => r.inputHash === undefined));
  if (withoutHash && editedIds.length === 0) {
    print(
      "NOTE: this file was written before runs recorded an input hash. If a case's PR, files or PRD were edited since, its row below grades a report written for the old inputs and means nothing. Name such cases with --edited <id,id> to leave them out.",
    );
  }

  const rows = saved.variants.flatMap((variant, i) => {
    const runs = regraded[i]?.runs ?? [];
    const kept = runs.filter((r): r is RegradedRun & { grade: CaseGrade } => r.grade !== null);
    const seconds =
      variant.runs.length > 0 ? variant.runs.reduce((n, r) => n + r.seconds, 0) / variant.runs.length : 0;
    const cost = { costUsd: variant.costUsd, judgeCostUsd: variant.judgeCostUsd, avgSeconds: seconds };

    print('');
    print(`${variant.label}`);
    for (const r of runs) {
      const name = `${r.caseId}#${r.rep + 1}`.padEnd(32);
      const word = (pass: boolean): string => (pass ? 'pass' : 'FAIL');
      if (r.status === 'stale')
        print(`  ${name} stale: the case inputs changed after this run, not re-graded`);
      else if (r.status === 'unknown_case') print(`  ${name} skipped: no such case any more`);
      else if (r.after !== r.before) print(`  ${name} ${word(r.before)} → ${word(r.after === true)}`);
    }
    const changed = runs.filter((r) => r.status === 'regraded' && r.after !== r.before).length;
    const dropped = runs.length - kept.length;
    print(`  ${changed} verdict(s) changed, ${kept.length - changed} unchanged, ${dropped} not re-graded`);

    return [
      {
        label: `${variant.label} (as recorded)`,
        summary: summarize(
          variant.runs.map((r) => r.grade),
          variant.errors.length,
        ),
        ...cost,
      },
      {
        label: `${variant.label} (re-graded)`,
        summary: summarize(
          kept.map((r) => r.grade),
          variant.errors.length,
        ),
        ...cost,
      },
    ];
  });

  print('');
  print(formatSummaryTable(rows));
  return { exitCode: 0, executed: false, estimateUsd: 0, regraded };
}
