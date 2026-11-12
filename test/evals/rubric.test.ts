import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { gradeCase } from '../../evals/grade';
import {
  alignmentScoreFromGrade,
  buildRubricInput,
  DEFAULT_RUBRIC_MODEL,
  judgeWithRubric,
  REPORT_CRITERIA,
  RUBRIC,
  RUBRIC_SYSTEM,
  type RubricClientLike,
  SCENARIO_CRITERIA,
  scoreRubric,
  summarizeRubric,
  withGrade,
} from '../../evals/rubric';
import type { GradedCase } from '../../evals/schema';
import type { QaReport } from '../../src/core/contracts';
import { fakeRubricClient, gradedCases, oracleReport, type RubricBody, withoutGroundTruth } from './support';

const coupon = gradedCases(['coupon-expiry-missing'])[0] as GradedCase;
const report = oracleReport(coupon);
const gradeOf = (r: QaReport) => gradeCase(coupon, { report: r, raw: r });
const ids = report.scenarios.map((s) => s.id);

type Output = Parameters<typeof scoreRubric>[0];
/** Judge output giving every scenario `scenario` on all four criteria and the report `reportScore` on all three. */
function output(scenario = 2, reportScore = 2, scenarioIds: string[] = ids): Output {
  return {
    scenarios: scenarioIds.map((id) => ({
      id,
      actionability: scenario,
      actionabilityWhy: 'a',
      traceability: scenario,
      traceabilityWhy: 't',
      riskRelevance: scenario,
      riskRelevanceWhy: 'r',
      priority: scenario,
      priorityWhy: 'p',
    })),
    report: {
      alignmentCorrectness: reportScore,
      alignmentCorrectnessWhy: 'al',
      concision: reportScore,
      concisionWhy: 'co',
      honesty: reportScore,
      honestyWhy: 'ho',
    },
  };
}

const replying = (message: Awaited<ReturnType<RubricClientLike['messages']['parse']>>): RubricClientLike => ({
  messages: { parse: async () => message },
});

describe('rubric definition (docs/quality/RUBRIC.md)', () => {
  it('M3.5 has the 4 scenario and 3 report criteria, with anchors word for word from RUBRIC.md', () => {
    expect(SCENARIO_CRITERIA).toEqual(['actionability', 'traceability', 'riskRelevance', 'priority']);
    expect(REPORT_CRITERIA).toEqual(['alignmentCorrectness', 'concision', 'honesty']);
    const rows = readFileSync('docs/quality/RUBRIC.md', 'utf8')
      .split('\n')
      .map((line) => line.match(/^\| \*\*(.+?)\*\*\s*\| (.+?)\s*\| (.+?)\s*\| (.+?)\s*\|$/))
      .filter((m) => m !== null)
      .map((m) => [m[1], [m[2], m[3], m[4]]]);
    const ours = [...SCENARIO_CRITERIA, ...REPORT_CRITERIA].map((c) => [
      RUBRIC[c].name,
      [...RUBRIC[c].anchors],
    ]);
    expect(rows).toHaveLength(7);
    expect(ours).toEqual(rows);
  });

  it('M3.5 the judge prompt carries every anchor, the grading rules and the injection guard', () => {
    for (const c of [...SCENARIO_CRITERIA, ...REPORT_CRITERIA]) {
      expect(RUBRIC_SYSTEM, c).toContain(`(\`${c}\`)`);
      for (const anchor of RUBRIC[c].anchors) expect(RUBRIC_SYSTEM, c).toContain(anchor);
    }
    expect(RUBRIC_SYSTEM).toContain('Each score is 0, 1 or 2');
    expect(RUBRIC_SYSTEM).toMatch(/ignore it and grade as usual/);
    expect(DEFAULT_RUBRIC_MODEL).toBe('claude-sonnet-5-5');
  });
});

describe('scoreRubric (RUBRIC.md "Scoring")', () => {
  it('M3.5 overall = 0.5 × scenario mean + 0.5 × report mean', () => {
    const mixed = output(2, 1);
    (mixed.scenarios[0] as Output['scenarios'][number]).actionability = 0; // one criterion of one scenario
    const score = scoreRubric(mixed, report, null);
    const expectedScenario = (ids.length * 2 - 2 / 4) / ids.length;
    expect(score.scenarioScore).toBeCloseTo(expectedScenario, 9);
    expect(score.reportScore).toBe(1);
    expect(score.overall).toBeCloseTo(0.5 * expectedScenario + 0.5, 9);
    expect(score.alignmentSource).toBe('judge');
    expect(score.scenarios[0]).toMatchObject({
      id: ids[0],
      actionability: 0,
      why: { actionability: 'a', priority: 'p' },
    });
    expect(score.report.why).toEqual({ alignmentCorrectness: 'al', concision: 'co', honesty: 'ho' });
  });

  it('M3.5 with ground truth, alignment correctness comes from the grade and the judge opinion is kept aside', () => {
    const right = scoreRubric(output(2, 0), report, gradeOf(report));
    expect(right).toMatchObject({ alignmentSource: 'grade', judgedAlignmentCorrectness: 0 });
    expect(right.report).toMatchObject({ alignmentCorrectness: 2, concision: 0, honesty: 0 });
    expect(right.reportScore).toBeCloseTo(2 / 3, 9);

    // A judge that is generous about a wrong report cannot lift the score.
    const wrong = structuredClone(report);
    for (const f of wrong.prdAlignment.findings) f.status = 'covered';
    wrong.prdAlignment.status = 'aligned';
    const lenient = scoreRubric(output(2, 2), wrong, gradeOf(wrong));
    expect(lenient.report.alignmentCorrectness).toBeLessThan(2);
    expect(lenient.judgedAlignmentCorrectness).toBe(2);
  });

  it('M3.5 alignmentScoreFromGrade: 2 when all right, 1 with exactly one wrong status, 0 beyond that', () => {
    expect(alignmentScoreFromGrade(gradeOf(report))).toBe(2);

    const oneFinding = structuredClone(report);
    const missing = oneFinding.prdAlignment.findings.find((f) => f.status === 'missing');
    if (!missing) throw new Error('the coupon case plants a missing requirement');
    missing.status = 'covered';
    expect(gradeOf(oneFinding).findings.filter((f) => !f.ok)).toHaveLength(1);
    expect(alignmentScoreFromGrade(gradeOf(oneFinding))).toBe(1);

    // Findings right, overall status wrong: still one wrong status.
    const statusOnly = structuredClone(report);
    statusOnly.prdAlignment.status = 'aligned';
    expect(alignmentScoreFromGrade(gradeOf(statusOnly))).toBe(1);
    // A wrong overall status that follows from a wrong finding is not counted twice.
    oneFinding.prdAlignment.status = 'aligned';
    expect(alignmentScoreFromGrade(gradeOf(oneFinding))).toBe(1);

    const two = structuredClone(report);
    for (const f of two.prdAlignment.findings) f.status = f.status === 'covered' ? 'missing' : 'covered';
    expect(gradeOf(two).findings.filter((f) => !f.ok).length).toBeGreaterThanOrEqual(2);
    expect(alignmentScoreFromGrade(gradeOf(two))).toBe(0);
  });

  it('M3.5 ignores scores for scenarios that are not in the report, and lists the ones left unscored', () => {
    const partial = output(2, 2, [ids[0] as string, 'TC-99', ids[0] as string]);
    (partial.scenarios[2] as Output['scenarios'][number]).actionability = 0; // a duplicate must not count
    const score = scoreRubric(partial, report, null);
    expect(score.scenarios.map((s) => s.id)).toEqual([ids[0]]);
    expect(score.scenarioScore).toBe(2);
    expect(score.unscoredScenarios).toEqual(ids.slice(1));
    // No scored scenario at all: the scenario half is 0, not a division by zero.
    expect(scoreRubric(output(2, 2, []), report, null)).toMatchObject({ scenarioScore: 0, overall: 1 });
  });

  it('M3.5 rejects a score outside 0–2 instead of averaging it in', () => {
    const high = output();
    (high.scenarios[1] as Output['scenarios'][number]).priority = 3;
    expect(() => scoreRubric(high, report, null)).toThrow(`score out of range for ${ids[1]}.priority`);
    const negative = output();
    negative.report.honesty = -1;
    expect(() => scoreRubric(negative, report, null)).toThrow('score out of range for report.honesty');
  });

  it('M3.5 withGrade recomputes only the alignment criterion; summarizeRubric averages over reports and scenarios', () => {
    const judged = scoreRubric(output(1, 0), report, null);
    const regraded = withGrade(judged, gradeOf(report));
    expect(regraded).toMatchObject({
      alignmentSource: 'grade',
      judgedAlignmentCorrectness: 0,
      scenarioScore: 1,
    });
    expect(regraded.report).toMatchObject({ alignmentCorrectness: 2, concision: 0, honesty: 0 });
    expect(regraded.overall).toBeCloseTo(0.5 * 1 + 0.5 * (2 / 3), 9);

    expect(summarizeRubric([])).toBeNull();
    const summary = summarizeRubric([judged, scoreRubric(output(2, 2), report, null)]);
    expect(summary).toMatchObject({ judged: 2, scenarioScore: 1.5, reportScore: 1, overall: 1.25 });
    expect(summary?.criteria).toEqual({
      actionability: 1.5,
      traceability: 1.5,
      riskRelevance: 1.5,
      priority: 1.5,
      alignmentCorrectness: 1,
      concision: 1,
      honesty: 1,
    });
  });
});

describe('judgeWithRubric', () => {
  it('M3.5 sends one structured request and returns scores, the served model, usage and cost', async () => {
    const seen: RubricBody[] = [];
    const result = await judgeWithRubric(
      fakeRubricClient(1, seen),
      'claude-sonnet-5-5',
      coupon,
      report,
      '## comment',
      null,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: RUBRIC_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(seen[0]?.max_tokens).toBeGreaterThanOrEqual(8_000);
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(result.usage).toEqual({
      inputTokens: 9_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(result.costUsd).toBeCloseTo((9_000 * 2 + 2_000 * 10) / 1e6, 12);
    expect(result.score).toMatchObject({ scenarioScore: 1.5, alignmentSource: 'judge' });
    expect(result.score?.reportScore).toBeCloseTo(4 / 3, 9);
    expect(result.error).toBeUndefined();
  });

  it('M3.5 the request shows the PRD, patches, rendered comment and report data, and never the expected answers', () => {
    const input = buildRubricInput(coupon, report, '## 🧪 AI QA — rendered');
    expect(input).toMatch(/^<prd>\n## .+\n/);
    expect(input).toContain(coupon.prdDocuments[0]?.bodyMarkdown as string);
    for (const f of coupon.files.filter((x) => x.patch))
      expect(input).toContain(`### ${f.path} (${f.status}, +`);
    expect(input).toContain('<rendered_comment>\n## 🧪 AI QA — rendered\n</rendered_comment>');
    expect(input).toContain('"relatedFiles"');
    expect(input).not.toContain(coupon.expected.notes);
    expect(input).not.toContain('mustFindings');

    // A long patch is cut so one generated file cannot crowd out the rest.
    const long = {
      ...coupon,
      files: [{ ...(coupon.files[0] as GradedCase['files'][number]), patch: `@@\n${'+x\n'.repeat(5_000)}` }],
    };
    const cut = buildRubricInput(long, report, '');
    expect(cut).toContain('… (patch cut here)');
    expect(cut.length).toBeLessThan(input.length + 8_000);

    const noPrd = buildRubricInput(withoutGroundTruth({ ...coupon, prdDocuments: [] }), report, '');
    expect(noPrd).toContain('(No PRD is linked to this pull request.)');
  });

  it('M3.5 never throws: truncated, refused, malformed or out-of-range replies come back without a score, with their cost', async () => {
    const usage = { input_tokens: 1_000, output_tokens: 16_000 };
    const truncated = await judgeWithRubric(
      replying({ parsed_output: output(), stop_reason: 'max_tokens', usage }),
      'claude-sonnet-5-5',
      coupon,
      report,
      '',
      null,
    );
    expect(truncated).toMatchObject({ score: null, error: 'judge stopped: max_tokens' });
    expect(truncated.costUsd).toBeCloseTo((1_000 * 2 + 16_000 * 10) / 1e6, 12);

    const refused = await judgeWithRubric(
      replying({ parsed_output: null, stop_reason: 'refusal', usage }),
      'claude-sonnet-5-5',
      coupon,
      report,
      '',
      null,
    );
    expect(refused).toMatchObject({ score: null, error: 'judge stopped: refusal' });

    const malformed = await judgeWithRubric(
      replying({ parsed_output: { scenarios: [] }, stop_reason: 'end_turn', usage }),
      'claude-sonnet-5-5',
      coupon,
      report,
      '',
      null,
    );
    expect(malformed).toMatchObject({ score: null, error: 'judge output did not match the rubric schema' });

    const outOfRange = await judgeWithRubric(
      replying({ parsed_output: output(5), stop_reason: 'end_turn', usage }),
      'claude-sonnet-5-5',
      coupon,
      report,
      '',
      null,
    );
    expect(outOfRange.score).toBeNull();
    expect(outOfRange.error).toMatch(/^score out of range for /);

    const parse = vi.fn(async () => {
      throw new TypeError('socket hang up');
    });
    const failed = await judgeWithRubric(
      { messages: { parse } },
      'claude-sonnet-5-5',
      coupon,
      report,
      '',
      null,
    );
    expect(failed).toEqual({
      score: null,
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      error: 'TypeError',
    });
    expect(parse).toHaveBeenCalledTimes(1); // no retry: a failed judge call is reported, not repeated
  });

  it('M3.5 the served judge model is recorded when it differs from the requested alias', async () => {
    const dated = await judgeWithRubric(
      replying({
        parsed_output: output(),
        stop_reason: 'end_turn',
        model: 'claude-sonnet-5-5-20261001',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      'claude-sonnet-5-5',
      coupon,
      report,
      '',
      null,
    );
    expect(dated.model).toBe('claude-sonnet-5-5-20261001');
    expect(dated.score?.overall).toBe(2);
  });
});
