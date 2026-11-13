/**
 * Deterministic grading for the v3 paths (SPEC v3 §8). No model call.
 *
 * Plan: does the sheet contain the cases that must be there (the risk units in `expected.json`,
 * matched by keyword), does every requirement have a case, how many lines break the style rules.
 * Verify: do the code statuses agree with what the case's requirement is known to be in the code.
 * Owner: qa-work-session-c(fable).
 */
import type { CaseDraft, LintCaseStyle, QaCase, VerifyResult } from '../../src/core/cases';
import type { Language } from '../../src/core/contracts';
import { requirementsOf } from '../../src/llm/prompts/plan';
import { avoidedWording } from '../../src/llm/prompts/style';
import { matchesGroups } from '../grade';
import type { GradedCase } from '../schema';

const caseText = (c: CaseDraft): string =>
  [c.title, ...c.preconditions, ...c.testData, ...c.steps, ...c.expected, c.whyEasyToMiss].join('\n');
const key = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Stand-in for `lintCaseStyle` until the cases module is merged: flags the wording the prompt
 * tells the model to avoid, plus emoji and a dash used for an afterthought. Coarser than the real
 * lint (no context, no quoted-text exception), so its counts are an upper-level signal only.
 */
export const fallbackLint: LintCaseStyle = (c, language) => {
  const violations: { rule: string; text: string }[] = [];
  const lines = [c.title, ...c.preconditions, ...c.steps, ...c.expected, c.whyEasyToMiss];
  const avoided = avoidedWording(language).map((w) =>
    w
      .replace(/^[~〜]|…/g, '')
      .trim()
      .toLowerCase(),
  );
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const word of avoided)
      if (word !== '' && lower.includes(word)) violations.push({ rule: 'avoided-wording', text: line });
    if (/\p{Extended_Pictographic}/u.test(line)) violations.push({ rule: 'emoji', text: line });
    if (/\s[—–]\s/.test(line)) violations.push({ rule: 'dash-aside', text: line });
  }
  if (/^\s*\[/.test(c.title)) violations.push({ rule: 'title-label', text: c.title });
  return violations;
};

export interface PlanGrade {
  caseId: string;
  cases: number;
  byPriority: Record<'P0' | 'P1' | 'P2', number>;
  techniques: number;
  /**
   * Risk units from `expected.json`. `hit`/`matchedCase`: a case contains the keywords.
   * `judgeCase`: the case the coverage judge named for the risk (null = none), when it ran.
   */
  mustCover: { id: string; hit: boolean; matchedCase: string | null; judgeCase?: string | null }[];
  /** By keyword. Understates a sheet that is not in the keywords' language. */
  mustCoverRecall: number;
  /** By the coverage judge, which reads for meaning in any language. Absent when it did not run. */
  mustCoverRecallJudge?: number;
  /** Requirements of the spec with no case at all. */
  requirementsWithoutCase: string[];
  requirementCoverage: number;
  /** Cases whose title repeats another one word for word. */
  repeatedTitles: number;
  /** Lines breaking a style rule, and the share of cases with at least one. */
  styleViolations: number;
  casesWithViolations: number;
  /** Cases with an open spec question named, or a non-empty reason they are easy to miss. */
  withWhy: number;
}

/** Grades the sheet written for one eval case. The spec is the case's first PRD document. */
export function gradePlan(
  evalCase: GradedCase,
  cases: QaCase[],
  language: Language,
  lint: LintCaseStyle,
): PlanGrade {
  const active = cases.filter((c) => c.lifecycle === 'active');
  const mustCover = evalCase.expected.mustScenarios.map((must) => {
    const hit = active.find((c) => matchesGroups(caseText(c), must.keywords));
    return { id: must.id, hit: hit !== undefined, matchedCase: hit?.caseId ?? null };
  });
  const spec = evalCase.prdDocuments[0];
  const labels = spec ? requirementsOf(spec).map((r) => r.label) : [];
  const covered = new Set(active.flatMap((c) => c.acLabels));
  const without = labels.filter((l) => !covered.has(l));
  const titles = active.map((c) => key(c.title));
  const perCase = active.map((c) => lint(c, language).length);
  return {
    caseId: evalCase.id,
    cases: active.length,
    byPriority: {
      P0: active.filter((c) => c.priority === 'P0').length,
      P1: active.filter((c) => c.priority === 'P1').length,
      P2: active.filter((c) => c.priority === 'P2').length,
    },
    techniques: new Set(active.map((c) => c.technique)).size,
    mustCover,
    mustCoverRecall: mustCover.length === 0 ? 1 : mustCover.filter((m) => m.hit).length / mustCover.length,
    requirementsWithoutCase: without,
    requirementCoverage: labels.length === 0 ? 1 : (labels.length - without.length) / labels.length,
    repeatedTitles: titles.length - new Set(titles).size,
    styleViolations: perCase.reduce((a, b) => a + b, 0),
    casesWithViolations: perCase.filter((n) => n > 0).length,
    withWhy: active.filter((c) => c.whyEasyToMiss.trim() !== '').length,
  };
}

/** Adds the coverage judge's verdicts (risk id -> case id or null) to a plan grade. */
export function withCoverageVerdicts(grade: PlanGrade, verdicts: Record<string, string | null>): PlanGrade {
  const mustCover = grade.mustCover.map((m) => ({ ...m, judgeCase: verdicts[m.id] ?? null }));
  return {
    ...grade,
    mustCover,
    mustCoverRecallJudge:
      mustCover.length === 0 ? 1 : mustCover.filter((m) => m.judgeCase !== null).length / mustCover.length,
  };
}

export interface VerifyGrade {
  caseId: string;
  /** One row per requirement with a known code state (from `expected.mustFindings`). */
  requirements: {
    id: string;
    expected: 'covered' | 'partial' | 'missing' | 'contradicts' | 'unclear';
    /** Statuses of the cases that test this requirement. */
    statuses: string[];
    ok: boolean;
  }[];
  /** Share of those requirements whose cases carry the right status. */
  codeStatusAccuracy: number;
  /** Share of cases left "unknown". High means the judgment said little. */
  unknownRate: number;
  alignment: { expected: string; actual: string; ok: boolean };
  /** Finding statuses, graded as in v2: by requirement label. */
  findingRecall: number;
  newCases: number;
}

/**
 * Grades the code statuses of one eval case against its ground truth.
 *
 * The ground truth is per requirement, not per case: a requirement known to be missing must have
 * at least one case marked missing, one known to be contradicted at least one marked contradicts,
 * and one known to be covered must have a case marked implemented and none marked contradicts.
 * (A case on a covered requirement may still be missing: an edge the code does not handle.)
 */
export function gradeVerify(evalCase: GradedCase, cases: QaCase[], result: VerifyResult): VerifyGrade {
  const statusOf = new Map(result.statuses.map((s) => [s.caseId, s.status]));
  const requirements = evalCase.expected.mustFindings.map((must) => {
    const expected = must.accept[0] ?? 'covered';
    const labels = new Set(must.labels.map((l) => l.toUpperCase()));
    const statuses = cases
      .filter((c) => c.acLabels.some((l) => labels.has(l.toUpperCase())))
      .map((c) => statusOf.get(c.caseId) ?? 'unknown');
    const ok =
      expected === 'missing'
        ? statuses.includes('missing')
        : expected === 'contradicts'
          ? statuses.includes('contradicts')
          : expected === 'covered' || expected === 'partial'
            ? statuses.includes('implemented') && !statuses.includes('contradicts')
            : !statuses.includes('contradicts'); // unclear: nothing in the code to contradict
    return { id: must.id, expected, statuses, ok };
  });
  const findingOk = evalCase.expected.mustFindings.map((must) => {
    const found = result.alignment.findings.filter((f) =>
      must.labels.some((label) =>
        new RegExp(`(^|[^A-Za-z0-9])${label}([^A-Za-z0-9]|$)`, 'i').test(f.requirement),
      ),
    );
    // `partial` (basic behavior there, an edge case missing) is what a partly built requirement
    // is called since verify 2026-11-13.7. Ground truth written before that says `missing` for it.
    const accepted = (s: (typeof found)[number]['status']): boolean =>
      must.accept.includes(s) || (s === 'partial' && must.accept.includes('missing'));
    return found.length > 0 && found.every((f) => accepted(f.status));
  });
  const all = result.statuses.length;
  return {
    caseId: evalCase.id,
    requirements,
    codeStatusAccuracy:
      requirements.length === 0 ? 1 : requirements.filter((r) => r.ok).length / requirements.length,
    unknownRate: all === 0 ? 0 : result.statuses.filter((s) => s.status === 'unknown').length / all,
    alignment: {
      expected: evalCase.expected.expectedAlignment,
      actual: result.alignment.status,
      ok: result.alignment.status === evalCase.expected.expectedAlignment,
    },
    findingRecall: findingOk.length === 0 ? 1 : findingOk.filter(Boolean).length / findingOk.length,
    newCases: result.newCases.length,
  };
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export interface PlanSummary {
  specs: number;
  cases: number;
  casesPerSpec: number;
  /** By keyword. */
  mustCoverRecall: number;
  /** By the coverage judge, over the specs it ran for; null when it ran for none. */
  mustCoverRecallJudge: number | null;
  requirementCoverage: number;
  repeatedTitles: number;
  styleViolations: number;
  /** Violations per 100 cases, so sheets of different length compare. */
  styleViolationsPer100: number;
}

/** Micro-averages over specs: must-cover recall over risk units, style violations over cases. */
export function summarizePlan(grades: PlanGrade[]): PlanSummary {
  const must = grades.flatMap((g) => g.mustCover);
  const judged = grades.filter((g) => g.mustCoverRecallJudge !== undefined).flatMap((g) => g.mustCover);
  const cases = grades.reduce((n, g) => n + g.cases, 0);
  const violations = grades.reduce((n, g) => n + g.styleViolations, 0);
  return {
    specs: grades.length,
    cases,
    casesPerSpec: grades.length === 0 ? 0 : cases / grades.length,
    mustCoverRecall: must.length === 0 ? 1 : must.filter((m) => m.hit).length / must.length,
    mustCoverRecallJudge:
      judged.length === 0 ? null : judged.filter((m) => m.judgeCase != null).length / judged.length,
    requirementCoverage: mean(grades.map((g) => g.requirementCoverage)),
    repeatedTitles: grades.reduce((n, g) => n + g.repeatedTitles, 0),
    styleViolations: violations,
    styleViolationsPer100: cases === 0 ? 0 : (violations / cases) * 100,
  };
}

/** The must-cover figure to compare runs by: the judge's when it ran, since it works in any language. */
export const mustCoverOf = (s: Pick<PlanSummary, 'mustCoverRecall' | 'mustCoverRecallJudge'>): number =>
  s.mustCoverRecallJudge ?? s.mustCoverRecall;

export interface VerifySummary {
  prs: number;
  codeStatusAccuracy: number;
  unknownRate: number;
  alignmentAccuracy: number;
  findingRecall: number;
  newCases: number;
}

export function summarizeVerify(grades: VerifyGrade[]): VerifySummary {
  const reqs = grades.flatMap((g) => g.requirements);
  return {
    prs: grades.length,
    codeStatusAccuracy: reqs.length === 0 ? 1 : reqs.filter((r) => r.ok).length / reqs.length,
    unknownRate: mean(grades.map((g) => g.unknownRate)),
    alignmentAccuracy: mean(grades.map((g) => (g.alignment.ok ? 1 : 0))),
    findingRecall: mean(grades.map((g) => g.findingRecall)),
    newCases: grades.reduce((n, g) => n + g.newCases, 0),
  };
}
