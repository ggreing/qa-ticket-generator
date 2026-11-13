/**
 * Improvement rounds for the v3 plan eval (docs/quality/RUBRIC.md "Scoring" and "Procedure").
 *
 * Kept apart from the M3.5 rounds: those score a different product with a different rubric, and
 * their numbers must not sit in one table with these. A round leaves
 *   evals/rounds/v3/<n>/raw/plan[.<lang>].json   every sheet and score (not committed)
 *   evals/rounds/v3/<n>/summary[.<lang>].md      what changed, the numbers, per-spec rows
 *   evals/rounds/v3/index.json                   the records behind ROUNDS.v3.md
 *   evals/ROUNDS.v3.md                           one row per round and language
 * A round is compared only with a kept round in the same language and rubric version.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import { mustCoverOf } from './grade';
import { CASE_CRITERIA, type CriterionV3, RUBRIC_V3, SHEET_CRITERIA } from './rubric';
import type { PlanResults, V3Deps } from './run';

export interface RoundRecordV3 {
  round: number;
  date: string;
  promptVersion: string;
  change: string;
  split: string;
  language: string;
  variant: string;
  judgeModel: string | null;
  rubricVersion: number | null;
  specs: number;
  errors: number;
  /** Sheets with a rubric score; the rubric means are over these. */
  judged: number;
  /** Sheets the judge was asked about and returned no usable score for. */
  unscored: string[];
  overall: number | null;
  caseScore: number | null;
  sheetScore: number | null;
  criteria: Partial<Record<CriterionV3, number>>;
  /** Overall per spec, so two rounds are compared on the specs both scored. */
  specOverall: Record<string, number>;
  casesPerSpec: number;
  /** Must-cover recall: by the coverage judge when it ran, else by keyword. */
  mustCover: number;
  mustCoverBy: 'judge' | 'keywords';
  requirementCoverage: number;
  styleViolationsPer100: number;
  repeatedTitles: number;
  /** Cases the merge step removed across all specs. */
  mergedAway: number;
  costUsd: number;
  judgeCostUsd: number;
  decision: 'pending' | 'keep' | 'revert';
  /** Set when the stored sheets were scored again after the run: when, and which part. */
  rescored?: { at: string; what: 'judge' | 'deterministic' };
}

const root = (deps: V3Deps): string => join(deps.evalsRoot, 'rounds', 'v3');
const indexPath = (deps: V3Deps): string => join(root(deps), 'index.json');
export const suffix = (language: string): string => (language === 'en' ? '' : `.${language}`);
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const score = (n: number | null | undefined): string => (n == null ? '—' : n.toFixed(2));
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const same = (a: RoundRecordV3, b: RoundRecordV3): boolean =>
  a.round === b.round && a.language === b.language;
const order = (a: RoundRecordV3, b: RoundRecordV3): number =>
  a.round - b.round || a.language.localeCompare(b.language);

function readIndex(deps: V3Deps): RoundRecordV3[] {
  try {
    const parsed = JSON.parse(deps.readFile(indexPath(deps))) as RoundRecordV3[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function toRecordV3(round: number, change: string, r: PlanResults): RoundRecordV3 {
  const merged = r.runs.reduce((n, run) => n + (run.merge?.mergedAway.length ?? 0), 0);
  return {
    round,
    date: r.startedAt,
    promptVersion: r.promptVersion,
    change: change.trim(),
    split: r.split,
    language: r.language,
    variant: `${r.model} · ${r.effort}`,
    judgeModel: r.judgeModel,
    rubricVersion: r.rubricVersion,
    specs: r.runs.length,
    errors: r.errors.length,
    judged: r.rubric?.judged ?? 0,
    unscored: r.runs
      .filter((x) => x.judge && !x.rubric)
      .map((x) => `${x.caseId} (${x.judge?.error ?? 'no score'})`),
    overall: r.rubric?.overall ?? null,
    caseScore: r.rubric?.caseScore ?? null,
    sheetScore: r.rubric?.sheetScore ?? null,
    criteria: r.rubric?.criteria ?? {},
    specOverall: Object.fromEntries(r.runs.flatMap((x) => (x.rubric ? [[x.caseId, x.rubric.overall]] : []))),
    casesPerSpec: r.summary.casesPerSpec,
    mustCover: mustCoverOf(r.summary),
    mustCoverBy: r.summary.mustCoverRecallJudge === null ? 'keywords' : 'judge',
    requirementCoverage: r.summary.requirementCoverage,
    styleViolationsPer100: r.summary.styleViolationsPer100,
    repeatedTitles: r.summary.repeatedTitles,
    mergedAway: merged,
    costUsd: r.costUsd,
    judgeCostUsd: r.judgeCostUsd,
    decision: 'pending',
  };
}

/** `evals/ROUNDS.v3.md`: one row per round and language, oldest first. */
export function renderRoundsIndexV3(records: RoundRecordV3[]): string {
  const lines = [
    '# Improvement rounds (v3: QA case sheets from a spec)',
    '',
    'Generated from `evals/rounds/v3/index.json` by the plan eval (`plan --round`, `--decision`). Do not edit by hand.',
    'Scores are rubric v3 means on a 0–2 scale (docs/quality/RUBRIC.md). Must-cover, requirements with a case and',
    'style violations are deterministic or checked against ground truth. A round is kept only if the overall rises',
    'and none of those three gets worse. Rows are comparable only within one language. "(13/14)" after an overall',
    'means the judge returned no usable score for the other sheets. The M3.5 rounds are in `ROUNDS.md`.',
    '',
    '| Round | Date | Prompt | Change | Split | Lang | Overall | Case | Sheet | Spec coverage | Must-cover | Req. with a case | Style viol./100 | Cases/spec | Merged away | Cost | Decision |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of [...records].sort(order)) {
    lines.push(
      `| ${[
        r.round,
        r.date.slice(0, 10),
        r.promptVersion,
        cell(r.change),
        r.split,
        r.language,
        `${score(r.overall)}${r.overall !== null && r.judged < r.specs ? ` (${r.judged}/${r.specs})` : ''}`,
        score(r.caseScore),
        score(r.sheetScore),
        score(r.criteria.coverage),
        `${pct(r.mustCover)}${r.mustCoverBy === 'keywords' ? ' (kw)' : ''}`,
        pct(r.requirementCoverage),
        r.styleViolationsPer100.toFixed(1),
        r.casesPerSpec.toFixed(1),
        r.mergedAway,
        `$${(r.costUsd + r.judgeCostUsd).toFixed(2)}`,
        r.decision,
      ].join(' | ')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface ComparisonV3 {
  baseline: number | null;
  rows: {
    metric: string;
    before: string;
    after: string;
    change: 'better' | 'same' | 'worse' | 'n/a';
    rule: boolean;
  }[];
  recommendation: 'keep' | 'revert' | 'none';
  reason: string;
}

const EPS = 1e-9;
const dir = (
  before: number | null,
  after: number | null,
  higherIsBetter = true,
): ComparisonV3['rows'][number]['change'] => {
  if (before === null || after === null) return 'n/a';
  if (Math.abs(after - before) <= EPS) return 'same';
  return after > before === higherIsBetter ? 'better' : 'worse';
};

/**
 * Compares a round with the latest earlier round marked keep in the same language and rubric
 * version. The overall is compared on the specs both rounds scored. Advice only.
 */
export function compareV3(record: RoundRecordV3, records: RoundRecordV3[]): ComparisonV3 {
  const kept = records
    .filter((r) => r.round < record.round && r.decision === 'keep')
    .sort((a, b) => b.round - a.round);
  const none = (reason: string, baseline: number | null = null): ComparisonV3 => ({
    baseline,
    rows: [],
    recommendation: 'none',
    reason,
  });
  if (kept.length === 0) {
    return none(
      record.round === 0
        ? 'Round 0 is the baseline. Mark it with plan --round 0 --decision keep so later rounds are compared with it.'
        : 'No earlier round is marked keep, so there is nothing to compare with.',
    );
  }
  const sameLanguage = kept.filter((r) => r.language === record.language);
  if (sameLanguage.length === 0) {
    return none(
      `The kept rounds were run in ${kept[0]?.language} and this one in ${record.language}. Sheets in different languages are not compared.`,
    );
  }
  const base =
    sameLanguage.find((r) => r.rubricVersion === record.rubricVersion && r.split === record.split) ??
    sameLanguage[0];
  if (!base) return none('No earlier round to compare with.');
  if (base.split !== record.split) {
    return none(
      `Round ${base.round} ran the "${base.split}" split and this round ran "${record.split}", so the numbers are not comparable.`,
      base.round,
    );
  }

  const shared = Object.keys(record.specOverall).filter((k) => base.specOverall[k] !== undefined);
  const paired = (scores: Record<string, number>): number | null =>
    shared.length === 0 ? null : shared.reduce((n, k) => n + (scores[k] as number), 0) / shared.length;
  const judgedBoth = base.rubricVersion !== null && base.rubricVersion === record.rubricVersion;
  const before = judgedBoth ? paired(base.specOverall) : null;
  const after = judgedBoth ? paired(record.specOverall) : null;
  const sameMust = base.mustCoverBy === record.mustCoverBy;
  const rows: ComparisonV3['rows'] = [
    { metric: 'Overall', before: score(before), after: score(after), change: dir(before, after), rule: true },
    {
      metric: `Must-cover (${record.mustCoverBy})`,
      before: sameMust ? pct(base.mustCover) : '—',
      after: pct(record.mustCover),
      change: sameMust ? dir(base.mustCover, record.mustCover) : 'n/a',
      rule: true,
    },
    {
      metric: 'Req. with a case',
      before: pct(base.requirementCoverage),
      after: pct(record.requirementCoverage),
      change: dir(base.requirementCoverage, record.requirementCoverage),
      rule: true,
    },
    {
      metric: 'Style viol./100',
      before: base.styleViolationsPer100.toFixed(1),
      after: record.styleViolationsPer100.toFixed(1),
      change: dir(base.styleViolationsPer100, record.styleViolationsPer100, false),
      rule: true,
    },
    {
      metric: 'Cases/spec',
      before: base.casesPerSpec.toFixed(1),
      after: record.casesPerSpec.toFixed(1),
      change: dir(base.casesPerSpec, record.casesPerSpec),
      rule: false,
    },
    {
      metric: 'Merged away',
      before: String(base.mergedAway),
      after: String(record.mergedAway),
      change: 'n/a',
      rule: false,
    },
    ...[...CASE_CRITERIA, ...SHEET_CRITERIA]
      .filter((c) => judgedBoth && base.criteria[c] !== undefined && record.criteria[c] !== undefined)
      .map((c) => ({
        metric: `${RUBRIC_V3[c].name} (0–2)`,
        before: score(base.criteria[c]),
        after: score(record.criteria[c]),
        change: dir(base.criteria[c] ?? null, record.criteria[c] ?? null),
        rule: false,
      })),
  ];
  const note =
    shared.length > 0 &&
    (shared.length < Object.keys(base.specOverall).length ||
      shared.length < Object.keys(record.specOverall).length)
      ? ` The overall is compared on the ${shared.length} sheets that both rounds scored.`
      : '';
  const ruleRows = rows.filter((r) => r.rule);
  if (ruleRows[0]?.change === 'n/a') {
    return {
      baseline: base.round,
      rows,
      recommendation: 'none',
      reason:
        'One of the two rounds has no rubric v3 score (run with --judge), so the overall cannot be compared.',
    };
  }
  const worse = ruleRows
    .slice(1)
    .filter((r) => r.change === 'worse')
    .map((r) => r.metric.toLowerCase());
  if (worse.length > 0) {
    return {
      baseline: base.round,
      rows,
      recommendation: 'revert',
      reason: `A deterministic metric got worse: ${worse.join(', ')}.${note}`,
    };
  }
  if (ruleRows[0]?.change !== 'better') {
    return {
      baseline: base.round,
      rows,
      recommendation: 'revert',
      reason: `The overall did not rise.${note}`,
    };
  }
  return {
    baseline: base.round,
    rows,
    recommendation: 'keep',
    reason: `The overall rose and no deterministic metric got worse.${note}`,
  };
}

export function formatComparisonV3(round: number, c: ComparisonV3): string[] {
  const advice =
    c.recommendation === 'none'
      ? `No recommendation for round ${round}: ${c.reason}`
      : `Recommendation for round ${round}: ${c.recommendation.toUpperCase()}. ${c.reason} Record the decision with plan --round ${round} --decision keep|revert.`;
  if (c.rows.length === 0) return [advice];
  return [
    `Compared with round ${c.baseline} (the last one kept):`,
    '',
    `| Metric | Round ${c.baseline} | Round ${round} | |`,
    '| --- | --- | --- | --- |',
    ...c.rows.map(
      (r) =>
        `| ${r.rule ? r.metric : `${r.metric} (context)`} | ${r.before} | ${r.after} | ${r.change === 'n/a' ? '—' : r.change} |`,
    ),
    '',
    'Rows marked "context" do not affect the recommendation.',
    '',
    advice,
  ];
}

/** `summary.md` of a round: the change, the numbers, one row per spec, what the judge found missing, what the merge removed. */
export function renderRoundSummaryV3(record: RoundRecordV3, r: PlanResults, table: string): string {
  const lines = [
    `# Round ${record.round} (v3 plan)`,
    '',
    `- Date: ${record.date.slice(0, 10)}`,
    `- Prompt: \`${record.promptVersion}\``,
    `- Change: ${record.change}`,
    `- Split: ${record.split}`,
    `- Language: ${record.language}`,
    `- Rubric judge: ${record.judgeModel ? `${record.judgeModel}, rubric v${record.rubricVersion}` : 'not run'}`,
    `- Must-cover checked by: ${record.mustCoverBy === 'judge' ? 'coverage judge (any language)' : 'keywords (mostly English)'}`,
    `- Style violations counted by: ${r.lintSource === 'cases' ? 'lintCaseStyle' : 'stand-in lint'}`,
    `- Decision: ${record.decision}`,
    ...(record.rescored
      ? [
          `- Scored again on ${record.rescored.at.slice(0, 10)}: ${record.rescored.what === 'judge' ? `rubric judge (rubric v${record.rubricVersion}) and deterministic metrics` : 'deterministic metrics only (style lint, keyword must-cover)'}. The sheets are the ones written on the date above.`,
        ]
      : []),
    '',
    '## Run',
    '',
    table,
    '',
  ];
  if (r.rubric) {
    lines.push('| Criterion | Mean (0–2) |', '| --- | --- |');
    for (const c of [...CASE_CRITERIA, ...SHEET_CRITERIA])
      lines.push(`| ${RUBRIC_V3[c].name} | ${score(r.rubric.criteria[c])} |`);
    lines.push('');
  }
  if (record.unscored.length > 0) {
    lines.push(
      `Rubric means cover ${record.judged} of ${record.specs} sheets. Left out, no usable judge score: ${record.unscored.join(', ')}.`,
      '',
    );
  }
  lines.push(
    '## Per spec',
    '',
    '| Spec | Cases | P0 | Overall | Spec coverage | Must-cover (kw) | Must-cover (judge) | Reqs without a case | Style viol. | Merged away | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const run of r.runs) {
    const g = run.grade;
    lines.push(
      `| ${[
        run.caseId,
        run.cases.length,
        run.cases.filter((c) => c.priority === 'P0').length,
        score(run.rubric?.overall),
        run.rubric ? run.rubric.sheet.coverage : '—',
        g ? pct(g.mustCoverRecall) : '—',
        g?.mustCoverRecallJudge !== undefined ? pct(g.mustCoverRecallJudge) : '—',
        g && g.requirementsWithoutCase.length > 0 ? cell(g.requirementsWithoutCase.join(', ')) : '—',
        g ? g.styleViolations : '—',
        run.merge?.mergedAway.length ?? 0,
        `$${run.costUsd.toFixed(2)}`,
      ].join(' | ')} |`,
    );
  }
  lines.push('');
  if (r.errors.length > 0) lines.push('No sheet:', ...r.errors.map((e) => `- ${e.caseId}: ${e.class}`), '');

  const missed = r.runs.flatMap((run) =>
    (run.grade?.mustCover ?? [])
      .filter((m) => (m.judgeCase !== undefined ? m.judgeCase === null : !m.hit))
      .map((m) => `${run.caseId}: ${m.id}`),
  );
  if (missed.length > 0)
    lines.push('## Must-cover risks with no case', '', ...missed.map((m) => `- ${m}`), '');
  const gaps = r.runs.flatMap((run) =>
    (run.rubric?.missingCases ?? []).map(
      (m) => `${run.caseId}: ${m.requirement} / ${m.technique}: ${cell(m.what)}`,
    ),
  );
  if (gaps.length > 0)
    lines.push('## What the rubric judge found missing', '', ...gaps.slice(0, 60).map((m) => `- ${m}`), '');
  const merged = r.runs.flatMap((run) =>
    (run.merge?.mergedAway ?? []).map(
      (m) =>
        `${run.caseId}: "${cell(m.title)}" removed as a repeat of "${cell(m.keptTitle)}" (${m.by}${m.reason ? `: ${cell(m.reason)}` : ''})`,
    ),
  );
  if (merged.length > 0) {
    lines.push(
      '## Cases the merge step removed',
      '',
      'Check that each one really repeats the case it was folded into.',
      '',
      ...merged.map((m) => `- ${m}`),
      '',
    );
  }
  return lines.join('\n');
}

function writeIndex(records: RoundRecordV3[], deps: V3Deps): void {
  const sorted = [...records].sort(order);
  deps.writeFile(indexPath(deps), `${JSON.stringify(sorted, null, 2)}\n`);
  deps.writeFile(join(deps.evalsRoot, 'ROUNDS.v3.md'), renderRoundsIndexV3(sorted));
}

/** Where a round's raw results go. */
export const roundResultsPath = (deps: V3Deps, round: number, language: string): string =>
  join(root(deps), String(round), 'raw', `plan${suffix(language)}.json`);

/**
 * Records a finished plan run as a round, replacing an earlier record of the same round and language.
 *
 * With `rescored` the sheets are those of an earlier run, scored again: the round keeps the change
 * text and the keep/revert decision it already has, unless a new change text is given.
 */
export function recordRoundV3(
  round: number,
  change: string,
  r: PlanResults,
  table: string,
  deps: V3Deps,
  rescored?: { at: string; what: 'judge' | 'deterministic' },
): void {
  const all = readIndex(deps);
  const earlier = rescored ? all.find((x) => x.round === round && x.language === r.language) : undefined;
  const text = change.trim() || earlier?.change || '';
  if (text === '') {
    deps.print(
      `Round ${round} (${r.language}) has no record yet, so there is no change text to keep. Add --change "<what changed in this round>" to record it.`,
    );
    return;
  }
  const record: RoundRecordV3 = {
    ...toRecordV3(round, text, r),
    ...(earlier ? { decision: earlier.decision } : {}),
    ...(rescored ? { rescored } : {}),
  };
  const others = all.filter((x) => !same(x, record));
  const comparison = formatComparisonV3(round, compareV3(record, others));
  const file = `summary${suffix(record.language)}.md`;
  deps.writeFile(
    join(root(deps), String(round), file),
    `${renderRoundSummaryV3(record, r, table)}\n## Compared with the last kept round\n\n${comparison.join('\n')}\n`,
  );
  writeIndex([...others, record], deps);
  deps.print(
    `Round ${round} recorded in evals/rounds/v3/${round}/${file} and evals/ROUNDS.v3.md (decision: ${record.decision}).`,
  );
  deps.print('');
  for (const line of comparison) deps.print(line);
}

/** Sets keep/revert for a recorded round (every language of it). No API call. */
export function decideRoundV3(round: number, decision: 'keep' | 'revert', deps: V3Deps): number {
  const records = readIndex(deps);
  const ofRound = records.filter((r) => r.round === round);
  if (ofRound.length === 0) {
    deps.print(`Round ${round} has not been recorded yet.`);
    return 2;
  }
  for (const r of ofRound) r.decision = decision;
  writeIndex(records, deps);
  deps.print(`Round ${round}: ${decision}. evals/ROUNDS.v3.md updated.`);
  return 0;
}
