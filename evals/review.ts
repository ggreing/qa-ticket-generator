/**
 * Human review support (docs/quality/RUBRIC.v2.md "Procedure"): a blind rating pack built from a
 * results file, and a comparison of the filled-in ratings with the rubric judge. Both are
 * offline. The pack never contains judge scores, expected answers or deterministic grades, so
 * the reviewer rates what a team would actually see.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import {
  type Criterion,
  REPORT_CRITERIA,
  type ReportCriterion,
  RUBRIC,
  SCENARIO_CRITERIA,
  type ScenarioCriterion,
} from './rubric';
import type { RunDeps, RunOptions, RunOutcome, RunRecord, SavedResults } from './run';
import type { EvalCase } from './schema';

/** Lines of patch shown per file in the change summary. */
const HUNK_LINES = 40;
const HUNK_FILES = 3;
/** RUBRIC.md: a mean disagreement above this means the judge or the rubric needs work first. */
export const CALIBRATION_LIMIT = 0.5;

type Slot = number | null;

export interface ReviewSample {
  sampleId: string;
  caseId: string;
  rep: number;
  origin: string;
  prd: { id: string; title: string; acceptanceCriteria: string[] }[];
  change: {
    title: string;
    files: { path: string; status: string; additions: number; deletions: number }[];
    hunks: { path: string; text: string }[];
  };
  /** The PR comment as rendered for this report. */
  ticketMarkdown: string;
  /** Empty rating slots: fill each with 0, 1 or 2. */
  ratings: {
    scenarios: { id: string; title: string; priority: string; scores: Record<ScenarioCriterion, Slot> }[];
    report: Record<ReportCriterion, Slot>;
    notes: string;
  };
}

export interface ReviewPack {
  version: 1;
  source: string;
  promptVersion: string;
  /** Language the sampled reports are written in. */
  language: string;
  variant: string;
  rubric: Record<Criterion, { name: string; level: 'scenario' | 'report'; anchors: readonly string[] }>;
  samples: ReviewSample[];
}

const none = (exitCode: number): RunOutcome => ({ exitCode, executed: false, estimateUsd: 0 });

function readResults(path: string, deps: RunDeps): SavedResults | null {
  try {
    const saved = JSON.parse(deps.readFile(path)) as SavedResults;
    return Array.isArray(saved.variants) ? saved : null;
  } catch {
    return null;
  }
}

/** Picks `count` runs spread across the score range (or across cases when nothing was judged). */
export function pickSamples(runs: RunRecord[], count: number): RunRecord[] {
  const sorted = [...runs].sort(
    (a, b) =>
      (a.rubric?.overall ?? 0) - (b.rubric?.overall ?? 0) ||
      a.caseId.localeCompare(b.caseId) ||
      a.rep - b.rep,
  );
  if (sorted.length <= count) return sorted;
  const picked = new Set<number>();
  for (let i = 0; i < count; i++) picked.add(Math.round((i * (sorted.length - 1)) / (count - 1 || 1)));
  return [...picked].sort((a, b) => a - b).map((i) => sorted[i] as RunRecord);
}

function toSample(run: RunRecord, evalCase: EvalCase): ReviewSample {
  const withPatch = [...evalCase.files].filter((f) => f.patch).sort((a, b) => b.additions - a.additions);
  return {
    sampleId: `${run.caseId}#${run.rep + 1}`,
    caseId: run.caseId,
    rep: run.rep,
    origin: evalCase.origin ?? 'synthetic',
    prd: evalCase.prdDocuments.map((d) => ({
      id: d.ref.id,
      title: d.title,
      acceptanceCriteria: d.acceptanceCriteria,
    })),
    change: {
      title: evalCase.pr.title,
      files: evalCase.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      hunks: withPatch.slice(0, HUNK_FILES).map((f) => ({
        path: f.path,
        text: (f.patch ?? '').split('\n').slice(0, HUNK_LINES).join('\n'),
      })),
    },
    ticketMarkdown: run.comment ?? '',
    ratings: {
      scenarios: run.report.scenarios.map((s) => ({
        id: s.id,
        title: s.title,
        priority: s.priority,
        scores: { actionability: null, traceability: null, riskRelevance: null, priority: null },
      })),
      report: { alignmentCorrectness: null, concision: null, honesty: null, coverage: null },
      notes: '',
    },
  };
}

/** `--review-pack`: writes the rating pack for the first variant of a results file. */
export function buildReviewPack(
  path: string,
  cases: EvalCase[],
  options: RunOptions,
  deps: RunDeps,
): RunOutcome {
  const saved = readResults(path, deps);
  const variant = saved?.variants[0];
  if (!saved || !variant) {
    deps.print(`Cannot build a review pack: ${path} is not a readable eval results file.`);
    return none(2);
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  const usable = variant.runs.filter((r) => byId.has(r.caseId) && r.comment);
  if (usable.length === 0) {
    deps.print('Cannot build a review pack: the results file has no rendered reports for the current cases.');
    return none(2);
  }
  const rubric = {} as ReviewPack['rubric'];
  for (const c of SCENARIO_CRITERIA)
    rubric[c] = { name: RUBRIC[c].name, level: 'scenario', anchors: RUBRIC[c].anchors };
  for (const c of REPORT_CRITERIA)
    rubric[c] = { name: RUBRIC[c].name, level: 'report', anchors: RUBRIC[c].anchors };
  const pack: ReviewPack = {
    version: 1,
    source: path,
    promptVersion: saved.promptVersion,
    language: saved.language ?? 'en',
    variant: variant.label,
    rubric,
    samples: pickSamples(usable, options.sample).map((run) =>
      toSample(run, byId.get(run.caseId) as EvalCase),
    ),
  };
  const out = options.out ?? join(deps.resultsRoot, 'review-pack.json');
  deps.writeFile(out, `${JSON.stringify(pack, null, 2)}\n`);
  deps.print(
    `Review pack with ${pack.samples.length} report(s) from "${variant.label}" (language ${pack.language}) written to ${out}. It holds no judge scores and no expected answers.`,
  );
  return none(0);
}

export interface CalibrationRow {
  criterion: Criterion;
  /** Rated pairs (person and judge both scored it). */
  pairs: number;
  human: number;
  judge: number;
  /** judge − human, averaged. Positive: the judge is more generous. */
  meanDiff: number;
  meanAbsDiff: number;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** Pairs each human score with the judge's score for the same report (and scenario). */
export function compareRatings(pack: ReviewPack, saved: SavedResults): CalibrationRow[] {
  const variant = saved.variants.find((v) => v.label === pack.variant) ?? saved.variants[0];
  const pairs = new Map<Criterion, [number, number][]>();
  const add = (criterion: Criterion, human: Slot, judge: number | undefined): void => {
    // `== null` also skips a slot that an older pack does not have, or a criterion the judge did not score.
    if (human == null || judge == null) return;
    pairs.set(criterion, [...(pairs.get(criterion) ?? []), [human, judge]]);
  };
  for (const sample of pack.samples) {
    const run = variant?.runs.find((r) => r.caseId === sample.caseId && r.rep === sample.rep);
    if (!run?.rubric) continue;
    for (const rated of sample.ratings.scenarios) {
      const judged = run.rubric.scenarios.find((s) => s.id === rated.id);
      for (const c of SCENARIO_CRITERIA) add(c, rated.scores[c], judged?.[c]);
    }
    // For alignment the judge's own opinion is compared, not the ground-truth override.
    add(
      'alignmentCorrectness',
      sample.ratings.report.alignmentCorrectness,
      run.rubric.judgedAlignmentCorrectness,
    );
    add('concision', sample.ratings.report.concision, run.rubric.report.concision);
    add('honesty', sample.ratings.report.honesty, run.rubric.report.honesty);
    add('coverage', sample.ratings.report.coverage, run.rubric.report.coverage);
  }
  return [...SCENARIO_CRITERIA, ...REPORT_CRITERIA].map((criterion) => {
    const list = pairs.get(criterion) ?? [];
    return {
      criterion,
      pairs: list.length,
      human: mean(list.map(([h]) => h)),
      judge: mean(list.map(([, j]) => j)),
      meanDiff: mean(list.map(([h, j]) => j - h)),
      meanAbsDiff: mean(list.map(([h, j]) => Math.abs(j - h))),
    };
  });
}

/** `--calibrate`: prints, per criterion, how far the judge is from the people who rated the pack. */
export function calibrate(ratingsPath: string, resultsPath: string, deps: RunDeps): RunOutcome {
  let pack: ReviewPack;
  try {
    pack = JSON.parse(deps.readFile(ratingsPath)) as ReviewPack;
    if (!Array.isArray(pack.samples)) throw new Error('no samples');
  } catch {
    deps.print(`Cannot calibrate: ${ratingsPath} is not a readable review pack.`);
    return none(2);
  }
  const saved = readResults(resultsPath, deps);
  if (!saved) {
    deps.print(`Cannot calibrate: ${resultsPath} is not a readable eval results file.`);
    return none(2);
  }
  const rows = compareRatings(pack, saved);
  const rated = rows.filter((r) => r.pairs > 0);
  if (rated.length === 0) {
    deps.print('Cannot calibrate: no rating in the pack matches a judged report in the results file.');
    return none(2);
  }
  deps.print(`Calibration of the rubric judge against ${ratingsPath} (scores 0–2)`);
  deps.print('');
  deps.print('| Criterion | Pairs | Human | Judge | Judge − human | Mean abs. diff |');
  deps.print('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const numbers =
      r.pairs === 0
        ? ['—', '—', '—', '—']
        : [r.human, r.judge, r.meanDiff, r.meanAbsDiff].map((n) => n.toFixed(2));
    const sign = r.pairs > 0 && r.meanDiff > 0 ? '+' : '';
    deps.print(
      `| ${RUBRIC[r.criterion].name} | ${r.pairs} | ${numbers[0]} | ${numbers[1]} | ${sign}${numbers[2]} | ${numbers[3]} |`,
    );
  }
  const overall = mean(rated.map((r) => r.meanAbsDiff));
  const off = rated.filter((r) => r.meanAbsDiff > CALIBRATION_LIMIT).map((r) => RUBRIC[r.criterion].name);
  deps.print('');
  deps.print(`Mean absolute difference across criteria: ${overall.toFixed(2)} (limit ${CALIBRATION_LIMIT}).`);
  deps.print(
    overall > CALIBRATION_LIMIT || off.length > 0
      ? `The judge disagrees with the ratings${off.length > 0 ? ` on: ${off.join(', ')}` : ''}. Refine the judge prompt or the rubric before trusting its scores.`
      : 'The judge is within the limit on every rated criterion.',
  );
  return none(0);
}
