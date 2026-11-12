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

/** Records a finished run as round `round` (replacing an earlier record of the same number). */
export function recordRound(
  round: number,
  change: string,
  saved: SavedResults,
  table: string,
  deps: RunDeps,
): void {
  const record = toRecord(round, change, saved);
  deps.writeFile(
    join(deps.evalsRoot, 'rounds', String(round), 'summary.md'),
    renderRoundSummary(record, saved, table),
  );
  writeIndex([...readIndex(deps).filter((r) => r.round !== round), record], deps);
  deps.print(
    `Round ${round} recorded in evals/rounds/${round}/summary.md and evals/ROUNDS.md (decision: pending).`,
  );
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
