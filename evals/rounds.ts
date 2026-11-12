/**
 * Improvement rounds (docs/quality/RUBRIC.md "Procedure"). Each paid run that belongs to a round
 * leaves three things: `evals/rounds/<n>/raw/results.json` (raw, not committed),
 * `evals/rounds/<n>/summary.md` (committed) and a row in `evals/ROUNDS.md`, which is regenerated
 * from `evals/rounds/index.json` so the history is one diffable file.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import { REPORT_CRITERIA, RUBRIC, SCENARIO_CRITERIA } from './rubric';
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
  variants: RoundVariant[];
  decision: 'pending' | 'keep' | 'revert';
}

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
    'metric falls.',
    '',
    '| Round | Date | Prompt | Change | Split | Variant | Overall | Scenario | Report | Pass | Alignment | Findings | Injection | Cost | Decision |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of [...records].sort((a, b) => a.round - b.round)) {
    for (const v of r.variants) {
      lines.push(
        `| ${[
          r.round,
          r.date.slice(0, 10),
          r.promptVersion,
          cell(r.change),
          r.split,
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
    `- Rubric judge: ${record.judgeModel ?? 'not run'}`,
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
        lines.push(`| ${RUBRIC[c].name} | ${variant.rubric.criteria[c].toFixed(2)} |`);
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
      costUsd: v.costUsd,
      judgeCostUsd: v.judgeCostUsd,
    })),
  };
}

function writeIndex(records: RoundRecord[], deps: RunDeps): void {
  const sorted = [...records].sort((a, b) => a.round - b.round);
  deps.writeFile(indexPath(deps), `${JSON.stringify(sorted, null, 2)}\n`);
  deps.writeFile(join(deps.evalsRoot, 'ROUNDS.md'), renderRoundsIndex(sorted));
}

export interface ComparisonRow {
  variant: string;
  metric: 'Overall' | 'Alignment' | 'Findings' | 'Injection';
  before: number | null;
  after: number | null;
  /** `n/a`: one side has no value, so the metric cannot be compared. */
  change: 'up' | 'same' | 'down' | 'n/a';
}

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
 * latest earlier round a person marked keep. This is advice; the decision is entered with --decision.
 */
export function compareWithLastKept(record: RoundRecord, records: RoundRecord[]): Comparison {
  const baseline = records
    .filter((r) => r.round < record.round && r.decision === 'keep')
    .sort((a, b) => b.round - a.round)[0];
  if (!baseline) {
    return {
      baseline: null,
      rows: [],
      recommendation: 'none',
      reason:
        record.round === 0
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
    for (const [metric, b, a] of pairs) {
      rows.push({ variant: after.label, metric, before: b, after: a, change: direction(b, a) });
    }
  }
  if (rows.length === 0) {
    return {
      baseline: baseline.round,
      rows,
      recommendation: 'none',
      reason: `Round ${baseline.round} has no variant with the same model and effort.`,
    };
  }
  const overall = rows.filter((r) => r.metric === 'Overall');
  const fell = rows.filter((r) => r.metric !== 'Overall' && r.change === 'down');
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
      reason: `A deterministic metric fell: ${names}.`,
    };
  }
  if (overall.some((r) => r.change !== 'up')) {
    return {
      baseline: baseline.round,
      rows,
      recommendation: 'revert',
      reason: 'The dev overall did not rise.',
    };
  }
  return {
    baseline: baseline.round,
    rows,
    recommendation: 'keep',
    reason: 'The dev overall rose and no deterministic metric fell.',
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
  const value = (metric: ComparisonRow['metric'], n: number | null): string =>
    n === null ? '—' : metric === 'Overall' ? n.toFixed(2) : pct(n);
  const delta = (r: ComparisonRow): string => {
    if (r.before === null || r.after === null) return '—';
    const d = r.after - r.before;
    const text = r.metric === 'Overall' ? Math.abs(d).toFixed(2) : `${(Math.abs(d) * 100).toFixed(0)} pt`;
    return r.change === 'same' ? '0' : `${d > 0 ? '+' : '−'}${text}`;
  };
  return [
    `Compared with round ${baseline} (the last one kept):`,
    '',
    `| Variant | Metric | Round ${baseline} | Round ${round} | Change |`,
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${cell(r.variant)} | ${r.metric} | ${value(r.metric, r.before)} | ${value(r.metric, r.after)} | ${delta(r)} |`,
    ),
    '',
    advice,
  ];
}

/** Records a finished run as round `round` (replacing an earlier record of the same number). */
export function recordRound(
  round: number,
  change: string,
  saved: SavedResults,
  table: string,
  deps: RunDeps,
): void {
  const record = toRecord(round, change, saved);
  const earlier = readIndex(deps).filter((r) => r.round !== round);
  const comparison = formatComparison(round, compareWithLastKept(record, earlier));
  deps.writeFile(
    join(deps.evalsRoot, 'rounds', String(round), 'summary.md'),
    `${renderRoundSummary(record, saved, table)}\n## Compared with the last kept round\n\n${comparison.join('\n')}\n`,
  );
  writeIndex([...earlier, record], deps);
  deps.print(
    `Round ${round} recorded in evals/rounds/${round}/summary.md and evals/ROUNDS.md (decision: pending).`,
  );
  deps.print('');
  for (const line of comparison) deps.print(line);
}

/** Sets keep/revert for a recorded round and regenerates ROUNDS.md. No API call. */
export function decideRound(round: number, decision: 'keep' | 'revert', deps: RunDeps): RunOutcome {
  const records = readIndex(deps);
  const record = records.find((r) => r.round === round);
  if (!record) {
    deps.print(`Round ${round} has not been recorded yet.`);
    return { exitCode: 2, executed: false, estimateUsd: 0 };
  }
  record.decision = decision;
  writeIndex(records, deps);
  deps.print(`Round ${round}: ${decision}. evals/ROUNDS.md updated.`);
  return { exitCode: 0, executed: false, estimateUsd: 0 };
}
