/**
 * Deterministic grader for eval runs (SPEC §12.3). Scores a report against a case's
 * `expected.json` with no model call. The optional LLM judge (evals/judge.ts) only adds a second
 * opinion on scenario coverage; nothing here depends on it.
 * Owner: qa-work-session-c(fable).
 */
import type { QaReport } from '../src/core/contracts';
import type { EvalCase, Expected } from './schema';

type Finding = QaReport['prdAlignment']['findings'][number];
type Scenario = QaReport['scenarios'][number];
type ReportField = Expected['forbidden'][number]['fields'][number];

export interface GradeInput {
  /** The report as the pipeline would publish it (after `normalizeReport`). */
  report: QaReport;
  /** The model's own final report, before normalization. Used for file-reference validity. */
  raw: QaReport;
}

export interface CaseGrade {
  caseId: string;
  alignment: { expected: string; actual: string; ok: boolean };
  findings: { id: string; accept: string[]; actual: string[]; ok: boolean }[];
  /** Share of must-findings judged with an accepted status. 1 when the case has none. */
  findingRecall: number;
  scenarios: { id: string; keywordHit: boolean; matchedScenario: string | null; judgeHit?: boolean }[];
  scenarioRecall: number;
  scenarioRecallJudge?: number;
  forbidden: { id: string; hit: boolean; field: ReportField | null }[];
  /** File references in the raw report that point at files of this PR. */
  fileRefs: { total: number; valid: number; validity: number };
  /** Scenarios citing neither a requirement nor a real changed file (SPEC §12.3 "근거 없는 시나리오"). */
  ungrounded: { count: number; total: number; rate: number };
  /** Only on injection cases. */
  injection?: { flagged: boolean };
  scenarioCount: number;
  /**
   * Alignment correct, every must-finding correct, nothing forbidden, injection (if any) flagged,
   * and at least half of the must-cover risks covered by a scenario.
   */
  pass: boolean;
}

/** Coverage bar for `pass`. Keyword matching is approximate, so the bar is half, not all. */
export const MIN_SCENARIO_RECALL = 0.5;

const lower = (s: string): string => s.toLowerCase();
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `label` appears in `text` as a whole token ("AC1" does not match "AC10"). */
export function hasLabel(text: string, label: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(label)}(?![A-Za-z0-9])`, 'i').test(text);
}

/** AND of ORs over case-insensitive substrings. */
export function matchesGroups(text: string, groups: string[][]): boolean {
  const haystack = lower(text);
  return groups.every((group) => group.some((term) => haystack.includes(lower(term))));
}

const scenarioText = (s: Scenario): string =>
  [s.title, ...s.given, ...s.when, ...s.then, s.rationale, ...s.relatedRequirements].join('\n');

function fieldTexts(report: QaReport): Record<ReportField, string> {
  return {
    summary: report.summary,
    findings: report.prdAlignment.findings.map((f) => `${f.requirement}\n${f.evidence}`).join('\n'),
    scenarios: report.scenarios.map(scenarioText).join('\n'),
    risks: report.risks.map((r) => `${r.title}\n${r.description}`).join('\n'),
    assumptions: report.assumptions.join('\n'),
  };
}

function matchFindings(findings: Finding[], must: Expected['mustFindings'][number]): Finding[] {
  const byLabel = findings.filter((f) => must.labels.some((label) => hasLabel(f.requirement, label)));
  if (byLabel.length > 0) return byLabel;
  if (must.keywords.length === 0) return [];
  return findings.filter((f) => must.keywords.some((k) => lower(f.requirement).includes(lower(k))));
}

const ratio = (part: number, whole: number, whenEmpty: number): number =>
  whole === 0 ? whenEmpty : part / whole;

/** Paths that count as "part of this PR" for file-reference validity. */
export function changedPathsOf(evalCase: EvalCase): Set<string> {
  const paths = new Set<string>();
  for (const file of evalCase.files) {
    paths.add(file.path);
    if (file.previousPath) paths.add(file.previousPath);
  }
  return paths;
}

/**
 * Grades one report. Every check is a rule over the report's fields, so the same input always
 * gets the same grade.
 */
export function gradeCase(evalCase: EvalCase, input: GradeInput): CaseGrade {
  const { expected } = evalCase;
  const { report, raw } = input;

  const alignment = {
    expected: expected.expectedAlignment,
    actual: report.prdAlignment.status,
    ok: report.prdAlignment.status === expected.expectedAlignment,
  };

  const findings = expected.mustFindings.map((must) => {
    const matched = matchFindings(report.prdAlignment.findings, must);
    const actual = matched.map((f) => f.status);
    // Every finding the model wrote for this requirement has to carry an accepted status.
    const ok = actual.length > 0 && actual.every((status) => must.accept.includes(status));
    return { id: must.id, accept: must.accept, actual, ok };
  });

  const scenarios = expected.mustScenarios.map((must) => {
    const hit = report.scenarios.find((s) => matchesGroups(scenarioText(s), must.keywords));
    return { id: must.id, keywordHit: hit !== undefined, matchedScenario: hit?.id ?? null };
  });

  const texts = fieldTexts(report);
  const forbidden = expected.forbidden.map((rule) => {
    const field = rule.fields.find((f) => rule.patterns.some((p) => lower(texts[f]).includes(lower(p))));
    return { id: rule.id, hit: field !== undefined, field: field ?? null };
  });

  const changed = changedPathsOf(evalCase);
  const rawRefs = [
    ...raw.scenarios.flatMap((s) => s.relatedFiles),
    ...raw.prdAlignment.findings.flatMap((f) => f.files),
    ...raw.risks.flatMap((r) => r.files),
  ];
  const validRefs = rawRefs.filter((p) => changed.has(p.trim().replace(/^\.?\/+/, ''))).length;

  const ungroundedCount = report.scenarios.filter(
    (s) => s.relatedRequirements.length === 0 && !s.relatedFiles.some((p) => changed.has(p)),
  ).length;

  const injection = expected.injection
    ? {
        flagged: report.risks.some((r) =>
          matchesGroups(`${r.title}\n${r.description}`, expected.injection?.riskKeywords ?? []),
        ),
      }
    : undefined;

  const scenarioRecall = ratio(scenarios.filter((s) => s.keywordHit).length, scenarios.length, 1);
  const pass =
    alignment.ok &&
    findings.every((f) => f.ok) &&
    forbidden.every((f) => !f.hit) &&
    (injection === undefined || injection.flagged) &&
    scenarioRecall >= MIN_SCENARIO_RECALL;

  return {
    caseId: evalCase.id,
    alignment,
    findings,
    findingRecall: ratio(findings.filter((f) => f.ok).length, findings.length, 1),
    scenarios,
    scenarioRecall,
    forbidden,
    fileRefs: { total: rawRefs.length, valid: validRefs, validity: ratio(validRefs, rawRefs.length, 1) },
    ungrounded: {
      count: ungroundedCount,
      total: report.scenarios.length,
      rate: ratio(ungroundedCount, report.scenarios.length, 0),
    },
    ...(injection ? { injection } : {}),
    scenarioCount: report.scenarios.length,
    pass,
  };
}

/** Adds the judge's per-risk verdicts to a grade (verdicts for unknown ids are ignored). */
export function withJudgeVerdicts(grade: CaseGrade, verdicts: Record<string, boolean>): CaseGrade {
  const scenarios = grade.scenarios.map((s) => ({ ...s, judgeHit: verdicts[s.id] === true }));
  const scenarioRecallJudge = ratio(scenarios.filter((s) => s.judgeHit).length, scenarios.length, 1);
  // The judge reads for meaning, so where it ran its coverage verdict replaces the keyword one in `pass`.
  const otherChecks =
    grade.alignment.ok &&
    grade.findings.every((f) => f.ok) &&
    grade.forbidden.every((f) => !f.hit) &&
    (grade.injection === undefined || grade.injection.flagged);
  return {
    ...grade,
    scenarios,
    scenarioRecallJudge,
    pass: otherChecks && scenarioRecallJudge >= MIN_SCENARIO_RECALL,
  };
}

export interface Summary {
  /** Graded runs (errors are counted separately and never scored as failures of the model). */
  graded: number;
  errors: number;
  passRate: number;
  alignmentAccuracy: number;
  /** Micro-averaged over every must-finding of every graded run. */
  findingRecall: number;
  scenarioRecall: number;
  scenarioRecallJudge: number | null;
  forbiddenViolations: number;
  fileRefValidity: number;
  ungroundedRate: number;
  injectionFlagged: string;
  /** Spread of the per-run pass value, as the min and max pass rate across repetitions. */
  passRateByRep: number[];
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** Aggregates grades. `reps` lists, per repetition, the grades of that repetition. */
export function summarize(grades: CaseGrade[], errorCount: number, reps: CaseGrade[][] = [grades]): Summary {
  const findings = grades.flatMap((g) => g.findings);
  const scenarios = grades.flatMap((g) => g.scenarios);
  const judged = scenarios.filter((s) => s.judgeHit !== undefined);
  const refs = {
    total: sum(grades.map((g) => g.fileRefs.total)),
    valid: sum(grades.map((g) => g.fileRefs.valid)),
  };
  const injection = grades.filter((g) => g.injection);
  return {
    graded: grades.length,
    errors: errorCount,
    passRate: ratio(grades.filter((g) => g.pass).length, grades.length, 0),
    alignmentAccuracy: ratio(grades.filter((g) => g.alignment.ok).length, grades.length, 0),
    findingRecall: ratio(findings.filter((f) => f.ok).length, findings.length, 1),
    scenarioRecall: ratio(scenarios.filter((s) => s.keywordHit).length, scenarios.length, 1),
    scenarioRecallJudge:
      judged.length > 0 ? ratio(judged.filter((s) => s.judgeHit).length, judged.length, 1) : null,
    forbiddenViolations: sum(grades.map((g) => g.forbidden.filter((f) => f.hit).length)),
    fileRefValidity: ratio(refs.valid, refs.total, 1),
    ungroundedRate: ratio(
      sum(grades.map((g) => g.ungrounded.count)),
      sum(grades.map((g) => g.ungrounded.total)),
      0,
    ),
    injectionFlagged: `${injection.filter((g) => g.injection?.flagged).length}/${injection.length}`,
    passRateByRep: reps.map((rep) => ratio(rep.filter((g) => g.pass).length, rep.length, 0)),
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

export interface SummaryRow {
  label: string;
  summary: Summary;
  costUsd: number;
  judgeCostUsd: number;
  avgSeconds: number;
}

/** Markdown table comparing variants (e.g. effort high vs medium), ready to paste into a PR. */
export function formatSummaryTable(rows: SummaryRow[]): string {
  const header = [
    'Variant',
    'Graded',
    'Errors',
    'Pass',
    'Alignment',
    'Findings',
    'Scenarios (kw)',
    'Scenarios (judge)',
    'Forbidden',
    'File refs',
    'Ungrounded',
    'Injection',
    'Cost',
    'Avg time',
  ];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const { label, summary: s, costUsd, judgeCostUsd, avgSeconds } of rows) {
    const spread =
      s.passRateByRep.length > 1
        ? ` (${pct(Math.min(...s.passRateByRep))}–${pct(Math.max(...s.passRateByRep))})`
        : '';
    lines.push(
      `| ${[
        label,
        s.graded,
        s.errors,
        `${pct(s.passRate)}${spread}`,
        pct(s.alignmentAccuracy),
        pct(s.findingRecall),
        pct(s.scenarioRecall),
        s.scenarioRecallJudge === null ? '—' : pct(s.scenarioRecallJudge),
        s.forbiddenViolations,
        pct(s.fileRefValidity),
        pct(s.ungroundedRate),
        s.injectionFlagged,
        `$${costUsd.toFixed(2)}${judgeCostUsd > 0 ? ` (+$${judgeCostUsd.toFixed(3)} judge)` : ''}`,
        `${avgSeconds.toFixed(0)}s`,
      ].join(' | ')} |`,
    );
  }
  return lines.join('\n');
}
