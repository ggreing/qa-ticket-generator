/**
 * Improvement rounds (docs/quality/RUBRIC.md "Procedure"). Each paid run that belongs to a round
 * leaves three things: `evals/rounds/<n>/raw/results.json` (raw, not committed),
 * `evals/rounds/<n>/summary.md` (committed) and a row in `evals/ROUNDS.md`, which is regenerated
 * from `evals/rounds/index.json` so the history is one diffable file.
 *
 * Scores from different rubric versions are not comparable. A record carries the version it was
 * judged with; when the rubric changes, an earlier round is re-scored (`--rejudge`) and gets a
 * second record for the new version, and comparisons only ever pair records of one version.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import { type Criterion, FIRST_RUBRIC_VERSION, REPORT_CRITERIA, RUBRIC, SCENARIO_CRITERIA } from './rubric';
import type { RunDeps, RunOutcome, SavedResults } from './run';

export interface RoundVariant {
  label: string;
  runs: number;
  errors: number;
  /** Rubric scores (0–2); null when the judge did not run. */
  overall: number | null;
  scenarioScore: number | null;
  reportScore: number | null;
  /** Deterministic metrics over the cases with ground truth. */
  graded: number;
  passRate: number;
  alignmentAccuracy: number;
  findingRecall: number;
  injectionFlagged: string;
  /** Share of must-cover risks hit by keyword. Absent in records written before it was stored. */
  scenarioRecall?: number;
  /** Mean number of tickets per report. Absent in records written before it was stored. */
  avgTickets?: number;
  /** Mean per rubric criterion. Absent in records written before it was stored. */
  criteria?: Partial<Record<Criterion, number | null>>;
  costUsd: number;
  judgeCostUsd: number;
}

export interface RoundRecord {
  round: number;
  date: string;
  promptVersion: string;
  change: string;
  split: string;
  judgeModel: string | null;
  /** Rubric the scores were judged with. Absent in records written under rubric v1. */
  rubricVersion?: number;
  /** True when the reports of an earlier run were scored again, with no new generation. */
  rejudged?: boolean;
  variants: RoundVariant[];
  decision: 'pending' | 'keep' | 'revert';
}

/** The rubric version of a record; records from before versions existed are v1. */
export const versionOf = (record: RoundRecord): number => record.rubricVersion ?? FIRST_RUBRIC_VERSION;
const sameRecord = (a: RoundRecord, b: RoundRecord): boolean =>
  a.round === b.round && versionOf(a) === versionOf(b);
const byRoundThenVersion = (a: RoundRecord, b: RoundRecord): number =>
  a.round - b.round || versionOf(a) - versionOf(b);

const indexPath = (deps: RunDeps): string => join(deps.evalsRoot, 'rounds', 'index.json');
const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
const score = (value: number | null): string => (value === null ? '—' : value.toFixed(2));
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function readIndex(deps: RunDeps): RoundRecord[] {
  try {
    const parsed = JSON.parse(deps.readFile(indexPath(deps))) as RoundRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** `evals/ROUNDS.md`: one row per round and variant, oldest first. */
export function renderRoundsIndex(records: RoundRecord[]): string {
  const lines = [
    '# Improvement rounds',
    '',
    'Generated from `evals/rounds/index.json` by the eval runner (`--round`, `--decision`). Do not edit by hand.',
    'Scores are rubric means on a 0–2 scale (docs/quality/RUBRIC.md); the percentages are the deterministic',
    'grades of the cases with ground truth. A round is kept only if the dev overall rises and no deterministic',
    'metric falls. Scores are comparable only within one rubric version: a row marked "re-scored" holds the',
    'same reports as the row above it, judged again with a newer rubric.',
    '',
    '| Round | Date | Prompt | Change | Split | Rubric | Variant | Overall | Scenario | Report | Pass | Alignment | Findings | Injection | Cost | Decision |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of [...records].sort(byRoundThenVersion)) {
    for (const v of r.variants) {
      lines.push(
        `| ${[
          r.round,
          r.date.slice(0, 10),
          r.promptVersion,
          cell(r.change),
          r.split,
          r.judgeModel ? `v${versionOf(r)}${r.rejudged ? ' (re-scored)' : ''}` : '—',
          cell(v.label),
          score(v.overall),
          score(v.scenarioScore),
          score(v.reportScore),
          v.graded > 0 ? pct(v.passRate) : '—',
          v.graded > 0 ? pct(v.alignmentAccuracy) : '—',
          v.graded > 0 ? pct(v.findingRecall) : '—',
          v.injectionFlagged,
          `$${(v.costUsd + v.judgeCostUsd).toFixed(2)}`,
          r.decision,
        ].join(' | ')} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** `evals/rounds/<n>/summary.md`: what changed, the variant table, criteria means, per-case results. */
export function renderRoundSummary(record: RoundRecord, saved: SavedResults, table: string): string {
  const lines = [
    `# Round ${record.round}`,
    '',
    `- Date: ${record.date.slice(0, 10)}`,
    `- Prompt: \`${record.promptVersion}\``,
    `- Change: ${record.change}`,
    `- Split: ${record.split}`,
    `- Rubric judge: ${record.judgeModel ? `${record.judgeModel}, rubric v${versionOf(record)}${record.rejudged ? ' (re-scored, no new generation)' : ''}` : 'not run'}`,
    `- Decision: ${record.decision}`,
    '',
    '## Variants',
    '',
    table,
    '',
  ];
  for (const variant of saved.variants) {
    lines.push(`## ${variant.label}`, '');
    if (variant.rubric) {
      lines.push('| Criterion | Mean (0–2) |', '| --- | --- |');
      for (const c of [...SCENARIO_CRITERIA, ...REPORT_CRITERIA]) {
        lines.push(`| ${RUBRIC[c].name} | ${score(variant.rubric.criteria[c])} |`);
      }
      lines.push('');
    }
    lines.push(
      '| Case | Origin | Overall | Scenario | Report | Grade | Alignment | Wrong findings | Tickets | Cost |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const run of variant.runs) {
      const g = run.grade;
      const wrong = g
        ? g.findings.filter((f) => !f.ok).map((f) => `${f.id}=${f.actual.join('/') || 'none'}`)
        : [];
      lines.push(
        `| ${[
          `${run.caseId}${run.rep > 0 ? ` #${run.rep + 1}` : ''}`,
          run.origin ?? 'synthetic',
          score(run.rubric?.overall ?? null),
          score(run.rubric?.scenarioScore ?? null),
          score(run.rubric?.reportScore ?? null),
          g ? (g.pass ? 'pass' : 'FAIL') : '—',
          g
            ? `${g.alignment.actual}${g.alignment.ok ? '' : ` (expected ${g.alignment.expected})`}`
            : run.report.prdAlignment.status,
          wrong.length > 0 ? cell(wrong.join(', ')) : '—',
          run.report.scenarios.length,
          `$${run.costUsd.toFixed(2)}`,
        ].join(' | ')} |`,
      );
    }
    lines.push('');
    if (variant.errors.length > 0) {
      lines.push('Not graded:', ...variant.errors.map((e) => `- ${e.caseId}: ${e.class}`), '');
    }
  }
  return `${lines.join('\n')}`;
}

function toRecord(round: number, change: string, saved: SavedResults): RoundRecord {
  return {
    round,
    date: saved.startedAt,
    promptVersion: saved.promptVersion,
    change: change.trim(),
    split: saved.split,
    judgeModel: saved.judgeModel,
    ...(saved.rubricVersion !== undefined ? { rubricVersion: saved.rubricVersion } : {}),
    ...(saved.rejudgedFrom !== undefined ? { rejudged: true } : {}),
    decision: 'pending',
    variants: saved.variants.map((v) => ({
      label: v.label,
      runs: v.runs.length,
      errors: v.errors.length,
      overall: v.rubric?.overall ?? null,
      scenarioScore: v.rubric?.scenarioScore ?? null,
      reportScore: v.rubric?.reportScore ?? null,
      graded: v.summary.graded,
      passRate: v.summary.passRate,
      alignmentAccuracy: v.summary.alignmentAccuracy,
      findingRecall: v.summary.findingRecall,
      injectionFlagged: v.summary.injectionFlagged,
      ...(v.summary.graded > 0 ? { scenarioRecall: v.summary.scenarioRecall } : {}),
      ...(v.runs.length > 0
        ? { avgTickets: v.runs.reduce((n, r) => n + r.report.scenarios.length, 0) / v.runs.length }
        : {}),
      ...(v.rubric ? { criteria: v.rubric.criteria } : {}),
      costUsd: v.costUsd,
      judgeCostUsd: v.judgeCostUsd,
    })),
  };
}

function writeIndex(records: RoundRecord[], deps: RunDeps): void {
  const sorted = [...records].sort(byRoundThenVersion);
  deps.writeFile(indexPath(deps), `${JSON.stringify(sorted, null, 2)}\n`);
  deps.writeFile(join(deps.evalsRoot, 'ROUNDS.md'), renderRoundsIndex(sorted));
}

export interface ComparisonRow {
  variant: string;
  metric:
    | 'Overall'
    | 'Alignment'
    | 'Findings'
    | 'Injection'
    | 'Pass'
    | 'Scenarios (kw)'
    | 'Tickets per report'
    | `${string} (0–2)`;
  before: number | null;
  after: number | null;
  /** `n/a`: one side has no value, so the metric cannot be compared. */
  change: 'up' | 'same' | 'down' | 'n/a';
  /** Shown for context; the recommendation does not depend on it. */
  context: boolean;
}

/** Context metrics where a fall deserves a look before deciding (fewer tickets is not a fall). */
const WATCHED: ComparisonRow['metric'][] = ['Pass', 'Scenarios (kw)'];

export interface Comparison {
  /** The round compared against: the latest earlier round marked keep. Null when there is none. */
  baseline: number | null;
  rows: ComparisonRow[];
  /** `none`: nothing to compare with, or no rubric score on one side. */
  recommendation: 'keep' | 'revert' | 'none';
  reason: string;
}

const EPSILON = 1e-9;
/** "3/4" → 0.75; null when the round had no injection case. */
const ratio = (text: string): number | null => {
  const [hit, total] = text.split('/').map(Number);
  return hit === undefined || !total || Number.isNaN(hit) ? null : hit / total;
};
const direction = (before: number | null, after: number | null): ComparisonRow['change'] =>
  before === null || after === null
    ? 'n/a'
    : after > before + EPSILON
      ? 'up'
      : after < before - EPSILON
        ? 'down'
        : 'same';

/**
 * RUBRIC.md "Scoring": a round improves only if the dev overall rises and no deterministic metric
 * (alignment accuracy, findings recall, injection resistance) falls. Compares `record` with the
 * latest earlier round a person marked keep, judged with the same rubric version. This is advice;
 * the decision is entered with --decision.
 */
export function compareWithLastKept(record: RoundRecord, records: RoundRecord[]): Comparison {
  const kept = records
    .filter((r) => r.round < record.round && r.decision === 'keep')
    .sort((a, b) => b.round - a.round);
  const baseline = kept.find((r) => versionOf(r) === versionOf(record));
  if (!baseline) {
    const other = kept[0];
    return {
      baseline: null,
      rows: [],
      recommendation: 'none',
      reason: other
        ? `Round ${other.round} was scored with rubric v${versionOf(other)} and this round with v${versionOf(record)}, and scores from different rubric versions are not comparable. Score round ${other.round} again first: --rejudge evals/rounds/${other.round}/raw/results.json --round ${other.round}.`
        : record.round === 0
          ? 'Round 0 is the baseline. Mark it with --round 0 --decision keep so later rounds are compared with it.'
          : 'No earlier round is marked keep, so there is nothing to compare with.',
    };
  }
  if (baseline.split !== record.split) {
    return {
      baseline: baseline.round,
      rows: [],
      recommendation: 'none',
      reason: `Round ${baseline.round} ran the "${baseline.split}" split and this round ran "${record.split}", so the scores are not comparable.`,
    };
  }
  const rows: ComparisonRow[] = [];
  for (const after of record.variants) {
    const before = baseline.variants.find((v) => v.label === after.label);
    if (!before) continue;
    const graded = before.graded > 0 && after.graded > 0;
    const pairs: [ComparisonRow['metric'], number | null, number | null][] = [
      ['Overall', before.overall, after.overall],
      ['Alignment', graded ? before.alignmentAccuracy : null, graded ? after.alignmentAccuracy : null],
      ['Findings', graded ? before.findingRecall : null, graded ? after.findingRecall : null],
      ['Injection', ratio(before.injectionFlagged), ratio(after.injectionFlagged)],
    ];
    const context: typeof pairs = [
      ['Pass', graded ? before.passRate : null, graded ? after.passRate : null],
      ['Scenarios (kw)', before.scenarioRecall ?? null, after.scenarioRecall ?? null],
      ['Tickets per report', before.avgTickets ?? null, after.avgTickets ?? null],
      // Which criterion moved, so the overall can be read rather than taken on trust.
      ...[...SCENARIO_CRITERIA, ...REPORT_CRITERIA]
        .filter((c) => before.criteria?.[c] != null && after.criteria?.[c] != null)
        .map((c): (typeof pairs)[number] => [
          `${RUBRIC[c].name} (0–2)`,
          before.criteria?.[c] ?? null,
          after.criteria?.[c] ?? null,
        ]),
    ];
    for (const [metric, b, a] of pairs) {
      rows.push({
        variant: after.label,
        metric,
        before: b,
        after: a,
        change: direction(b, a),
        context: false,
      });
    }
    for (const [metric, b, a] of context) {
      rows.push({
        variant: after.label,
        metric,
        before: b,
        after: a,
        change: direction(b, a),
        context: true,
      });
    }
  }
  const watched = [
    ...new Set(rows.filter((r) => WATCHED.includes(r.metric) && r.change === 'down').map((r) => r.metric)),
  ];
  // Not part of the rule in RUBRIC.md, but a person deciding should not miss it.
  const note =
    watched.length > 0
      ? ` Note: ${watched.join(' and ')} fell. That is outside the rule, so look at it before deciding.`
      : '';
  if (rows.length === 0) {
    return {
      baseline: baseline.round,
      rows,
      recommendation: 'none',
      reason: `Round ${baseline.round} has no variant with the same model and effort.`,
    };
  }
  const overall = rows.filter((r) => r.metric === 'Overall');
  const fell = rows.filter((r) => !r.context && r.metric !== 'Overall' && r.change === 'down');
  if (overall.some((r) => r.change === 'n/a')) {
    return {
      baseline: baseline.round,
      rows,
      recommendation: 'none',
      reason:
        'One of the two rounds has no rubric score (run with --judge), so the overall cannot be compared.',
    };
  }
  if (fell.length > 0) {
    const names = [...new Set(fell.map((r) => r.metric.toLowerCase()))].join(', ');
    return {
      baseline: baseline.round,
      rows,
      recommendation: 'revert',
      reason: `A deterministic metric fell: ${names}.${note}`,
    };
  }
  if (overall.some((r) => r.change !== 'up')) {
    return {
      baseline: baseline.round,
      rows,
      recommendation: 'revert',
      reason: `The dev overall did not rise.${note}`,
    };
  }
  return {
    baseline: baseline.round,
    rows,
    recommendation: 'keep',
    reason: `The dev overall rose and no deterministic metric fell.${note}`,
  };
}

/** The comparison as Markdown lines: a table and a one-line recommendation. */
export function formatComparison(round: number, comparison: Comparison): string[] {
  const { baseline, rows, recommendation, reason } = comparison;
  const advice =
    recommendation === 'none'
      ? `No recommendation for round ${round}: ${reason}`
      : `Recommendation for round ${round}: ${recommendation.toUpperCase()}. ${reason} Record the decision with --round ${round} --decision keep|revert.`;
  if (rows.length === 0) return [advice];
  const isScore = (metric: ComparisonRow['metric']): boolean =>
    metric === 'Overall' || metric.endsWith('(0–2)');
  const value = (metric: ComparisonRow['metric'], n: number | null): string =>
    n === null
      ? '—'
      : isScore(metric)
        ? n.toFixed(2)
        : metric === 'Tickets per report'
          ? n.toFixed(1)
          : pct(n);
  const delta = (r: ComparisonRow): string => {
    if (r.before === null || r.after === null) return '—';
    const d = Math.abs(r.after - r.before);
    const text = isScore(r.metric)
      ? d.toFixed(2)
      : r.metric === 'Tickets per report'
        ? d.toFixed(1)
        : `${(d * 100).toFixed(0)} pt`;
    return r.change === 'same' ? '0' : `${r.change === 'up' ? '+' : '−'}${text}`;
  };
  return [
    `Compared with round ${baseline} (the last one kept):`,
    '',
    `| Variant | Metric | Round ${baseline} | Round ${round} | Change |`,
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${cell(r.variant)} | ${r.context ? `${r.metric} (context)` : r.metric} | ${value(r.metric, r.before)} | ${value(r.metric, r.after)} | ${delta(r)} |`,
    ),
    '',
    'Rows marked "context" do not affect the recommendation.',
    '',
    advice,
  ];
}

/**
 * Records a finished run as round `round`, replacing an earlier record of the same round and
 * rubric version. Records of that round under another rubric version are kept.
 */
export function recordRound(
  round: number,
  change: string,
  saved: SavedResults,
  table: string,
  deps: RunDeps,
): void {
  const record = toRecord(round, change, saved);
  const others = readIndex(deps).filter((r) => !sameRecord(r, record));
  const comparison = formatComparison(round, compareWithLastKept(record, others));
  deps.writeFile(
    join(deps.evalsRoot, 'rounds', String(round), 'summary.md'),
    `${renderRoundSummary(record, saved, table)}\n## Compared with the last kept round\n\n${comparison.join('\n')}\n`,
  );
  writeIndex([...others, record], deps);
  deps.print(
    `Round ${round} recorded in evals/rounds/${round}/summary.md and evals/ROUNDS.md (decision: pending).`,
  );
  deps.print('');
  for (const line of comparison) deps.print(line);
}

/**
 * Records the re-scored results of round `round` next to its original record. The change text and
 * the decision are the round's own: the reports are the same, only the rubric is newer.
 */
export function recordRejudgedRound(round: number, saved: SavedResults, table: string, deps: RunDeps): void {
  const records = readIndex(deps);
  const original = records.find((r) => r.round === round);
  const record: RoundRecord = {
    ...toRecord(round, original?.change ?? 're-scored', saved),
    decision: original?.decision ?? 'pending',
  };
  const file = `summary.rubric-v${versionOf(record)}.md`;
  deps.writeFile(
    join(deps.evalsRoot, 'rounds', String(round), file),
    renderRoundSummary(record, saved, table),
  );
  writeIndex([...records.filter((r) => !sameRecord(r, record)), record], deps);
  deps.print(
    `Round ${round} re-scored with rubric v${versionOf(record)}: evals/rounds/${round}/${file} and evals/ROUNDS.md (decision: ${record.decision}, as recorded for the round).`,
  );
}

/** Sets keep/revert for a recorded round and regenerates ROUNDS.md. No API call. */
export function decideRound(round: number, decision: 'keep' | 'revert', deps: RunDeps): RunOutcome {
  const records = readIndex(deps);
  const ofRound = records.filter((r) => r.round === round);
  if (ofRound.length === 0) {
    deps.print(`Round ${round} has not been recorded yet.`);
    return { exitCode: 2, executed: false, estimateUsd: 0 };
  }
  // A round has one decision, whichever rubric versions it was scored with.
  for (const record of ofRound) record.decision = decision;
  writeIndex(records, deps);
  deps.print(`Round ${round}: ${decision}. evals/ROUNDS.md updated.`);
  return { exitCode: 0, executed: false, estimateUsd: 0 };
}
