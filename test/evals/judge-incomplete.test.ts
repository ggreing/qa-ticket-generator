/**
 * Rounds 1 (re-scored) and 2 had four judge replies that left scenarios unscored: three returned
 * an empty `scenarios` array (the scenario score became 0 and dragged the overall to 0.75–0.88),
 * and one returned seven entries of which only one id matched. These tests pin the repair.
 */
import { describe, expect, it, vi } from 'vitest';
import { gradeCase } from '../../evals/grade';
import {
  compareWithLastKept,
  formatComparison,
  type RoundRecord,
  type RoundVariant,
} from '../../evals/rounds';
import {
  buildRubricInput,
  judgeWithRubric,
  MIN_SCORED_SHARE,
  type RubricClientLike,
  scoredShare,
  scoreRubric,
  unscoredNote,
  unscoredReports,
} from '../../evals/rubric';
import { runEvals, type SavedResults } from '../../evals/run';
import type { GradedCase } from '../../evals/schema';
import { DEV, harness, RUBRIC_COST } from './harness';
import { fakeRubricClient, gradedCases, oracleReport, type RubricBody } from './support';

type Harness = ReturnType<typeof harness>;
type Reply = Awaited<ReturnType<RubricClientLike['messages']['parse']>>;
type Output = Parameters<typeof scoreRubric>[0];

const coupon = gradedCases(['coupon-expiry-missing'])[0] as GradedCase;
const report = oracleReport(coupon);
const ids = report.scenarios.map((s) => s.id);
const grade = gradeCase(coupon, { report, raw: report });

/** A judge whose reply to the n-th call (1-based) is rewritten by `rewrite`. */
function tampered(rewrite: (output: Output, call: number, body: RubricBody) => Output): {
  client: RubricClientLike;
  calls: () => number;
} {
  const good = fakeRubricClient();
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      messages: {
        parse: async (body) => {
          const reply = (await good.messages.parse(body)) as Reply;
          return { ...reply, parsed_output: rewrite(reply.parsed_output as Output, ++calls, body) };
        },
      },
    },
  };
}
const judge = (client: RubricClientLike) =>
  judgeWithRubric(client, 'claude-sonnet-5-5', coupon, report, '## comment', grade);
const withIds = (output: Output, newIds: string[]): Output => ({
  ...output,
  scenarios: output.scenarios.map((s, i) => ({ ...s, id: newIds[i] ?? s.id })),
});

describe('judge replies that leave scenarios unscored (M3.5 rounds 1–2 bug)', () => {
  it('M3.5 an empty scenarios array is asked for once more, and the second reply is the score', async () => {
    const { client, calls } = tampered((output, call) =>
      call === 1 ? { ...output, scenarios: [] } : output,
    );
    const result = await judge(client);

    expect(calls()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.score?.scenarios.map((s) => s.id)).toEqual(ids);
    expect(result.score?.scenarioScore).toBe(1.5);
    // Both calls were paid for.
    expect(result.costUsd).toBeCloseTo(2 * RUBRIC_COST, 12);
    expect(result.usage).toMatchObject({ inputTokens: 18_000, outputTokens: 4_000 });
  });

  it('M3.5 two short replies give no score at all, never a scenario score of 0', async () => {
    const { client, calls } = tampered((output) => ({ ...output, scenarios: [] }));
    const result = await judge(client);

    expect(calls()).toBe(2); // one retry, not a loop
    expect(result.score).toBeNull();
    expect(result.error).toBe(`judge incomplete: scored 0 of ${ids.length} scenarios in two attempts`);
    expect(result).toMatchObject({ attempts: 2 });
    expect(result.costUsd).toBeCloseTo(2 * RUBRIC_COST, 12);
    // What the old code did with the same reply: a full report score and half the overall gone.
    const zeroFilled = scoreRubric({ ...(fake() as Output), scenarios: [] }, report, grade);
    expect(zeroFilled).toMatchObject({ scenarioScore: 0, reportScore: 1.5, overall: 0.75 });
    expect(scoredShare(zeroFilled)).toBe(0);
  });

  it('M3.5 a reply that covers at least half is kept as it is, with the rest listed as unscored', async () => {
    expect(MIN_SCORED_SHARE).toBe(0.5);
    const keep = Math.ceil(ids.length / 2);
    const { client, calls } = tampered((output) => ({
      ...output,
      scenarios: output.scenarios.slice(0, keep),
    }));
    const result = await judge(client);
    expect(calls()).toBe(1);
    expect(result.attempts).toBeUndefined();
    expect(result.score?.scenarios).toHaveLength(keep);
    expect(result.score?.unscoredScenarios).toEqual(ids.slice(keep));
    expect(result.score?.scenarioScore).toBe(1.5); // the mean of the scenarios that were scored

    // One short of half: retried.
    const short = tampered((output, call) =>
      call === 1 ? { ...output, scenarios: output.scenarios.slice(0, keep - 1) } : output,
    );
    expect((await judge(short.client)).attempts).toBe(ids.length > 1 ? 2 : undefined);
  });

  it('M3.5 a report without scenarios is complete, and a failed call is not retried', async () => {
    const empty = { ...report, scenarios: [] };
    const good = tampered((output) => output);
    const result = await judgeWithRubric(good.client, 'claude-sonnet-5-5', coupon, empty, '', null);
    expect(good.calls()).toBe(1);
    expect(result.score).toMatchObject({ scenarios: [], unscoredScenarios: [], scenarioScore: 0 });
    expect(scoredShare(result.score as NonNullable<typeof result.score>)).toBe(1);

    const parse = vi.fn(async () => {
      throw new Error('overloaded');
    });
    expect((await judge({ messages: { parse } })).error).toBe('Error');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('M3.5 the request ends by naming every scenario id that needs an entry', () => {
    const input = buildRubricInput(coupon, report, '');
    expect(
      input.endsWith(
        `</report_data>\nReturn one entry in \`scenarios\` for each of these ${ids.length} scenarios, with exactly these ids: ${ids.join(', ')}.`,
      ),
    ).toBe(true);
    expect(buildRubricInput(coupon, { ...report, scenarios: [] }, '')).toMatch(
      /<\/report_data>\nThe report has no scenarios, so `scenarios` stays empty\.$/,
    );
  });
});

/** The standard double's output for the coupon report, for building variations. */
function fake(): Output {
  return {
    importantRisks: [],
    scenarios: ids.map((id) => ({
      id,
      actionability: 1,
      actionabilityWhy: 'a',
      traceability: 2,
      traceabilityWhy: 't',
      riskRelevance: 1,
      riskRelevanceWhy: 'r',
      priority: 2,
      priorityWhy: 'p',
    })),
    report: {
      alignmentCorrectness: 0,
      alignmentCorrectnessWhy: 'al',
      concision: 1,
      concisionWhy: 'co',
      honesty: 2,
      honestyWhy: 'ho',
      coverage: 1,
      coverageWhy: 'cv',
    },
  };
}

describe('matching judge entries to scenarios (M3.5 rounds 1–2 bug)', () => {
  it('M3.5 reads ids loosely: "TC-1", "tc 02", "TC-03: title" and a bare number all match', () => {
    const loose = ['TC-1', 'tc 02', `TC-03: ${report.scenarios[2]?.title ?? ''}`, '4'].slice(0, ids.length);
    const score = scoreRubric(withIds(fake(), loose), report, null);
    expect(score.scenarios.map((s) => s.id)).toEqual(ids.slice(0, loose.length));
    expect(score.unscoredScenarios).toEqual(ids.slice(loose.length));
    expect(score.matchedBy).toEqual({ id: 0, normalizedId: loose.length, title: 0, position: 0 });
    expect(score.unmatchedJudgeIds).toBeUndefined();
    // "TC-10" is not "TC-1".
    const ten = scoreRubric(
      { ...fake(), scenarios: [{ ...(fake().scenarios[0] as Output['scenarios'][number]), id: 'TC-10' }] },
      report,
      null,
    );
    expect(ten.scenarios).toEqual([]);
    expect(ten.unmatchedJudgeIds).toEqual(['TC-10']);
  });

  it('M3.5 a title where the id belongs is matched by title', () => {
    const titles = report.scenarios.map((s) => s.title);
    const score = scoreRubric(withIds(fake(), titles), report, null);
    expect(score.scenarios.map((s) => s.id)).toEqual(ids);
    expect(score.matchedBy).toMatchObject({ id: 0, title: ids.length });
  });

  it('M3.5 one entry per scenario with repeated or unusable ids is matched by position (the 1-of-7 reply)', () => {
    // Every entry carries the first id: before the fix only the first one counted.
    const repeated = scoreRubric(
      withIds(
        fake(),
        ids.map(() => ids[0] as string),
      ),
      report,
      null,
    );
    expect(repeated.scenarios.map((s) => s.id)).toEqual(ids);
    expect(repeated.matchedBy).toEqual({ id: 1, normalizedId: 0, title: 0, position: ids.length - 1 });
    expect(scoredShare(repeated)).toBe(1);

    const garbage = scoreRubric(
      withIds(
        fake(),
        ids.map((_, i) => `scenario ${'abcdefgh'[i]}`),
      ),
      report,
      null,
    );
    expect(garbage.scenarios.map((s) => s.id)).toEqual(ids);
    expect(garbage.matchedBy?.position).toBe(ids.length);

    // Position is only trusted when the counts agree: a short list of unusable ids stays unmatched.
    const short = withIds(
      fake(),
      ids.map(() => 'nonsense'),
    );
    short.scenarios.pop();
    const unmatched = scoreRubric(short, report, null);
    expect(unmatched.scenarios).toEqual([]);
    expect(unmatched.unmatchedJudgeIds).toHaveLength(ids.length - 1);
  });

  it('M3.5 scores are stored in report order whatever order the judge answered in', () => {
    const reversed = { ...fake(), scenarios: [...fake().scenarios].reverse() };
    (reversed.scenarios[0] as Output['scenarios'][number]).priority = 0; // the last scenario of the report
    const score = scoreRubric(reversed, report, null);
    expect(score.scenarios.map((s) => s.id)).toEqual(ids);
    expect(score.scenarios.at(-1)?.priority).toBe(0);
    expect(score.matchedBy).toBeUndefined(); // all by exact id
  });
});

describe('reports without a judge score in runs and rounds (M3.5)', () => {
  const BROKEN = 'coupon-expiry-missing';
  /** A judge that never returns scenario entries for one case, recognised by its PRD title in the request. */
  const breaking = (): RubricClientLike => {
    const good = fakeRubricClient();
    const marker = coupon.prdDocuments[0]?.title ?? '(no prd)';
    return {
      messages: {
        parse: async (body) => {
          const reply = (await good.messages.parse(body)) as Reply;
          return String(body.messages[0]?.content).includes(marker)
            ? { ...reply, parsed_output: { ...(reply.parsed_output as Output), scenarios: [] } }
            : reply;
        },
      },
    };
  };

  async function roundWithBrokenCase(
    round: string,
  ): Promise<{ h: Harness; saved: SavedResults; path: string }> {
    const h = harness({ createRubricClient: breaking });
    await runEvals(
      [
        '--yes',
        '--judge',
        '--round',
        round,
        '--change',
        'broken judge',
        '--cases',
        `${BROKEN},report-timezone,rbac-export-role`,
      ],
      h.deps,
    );
    const path = `evals/rounds/${round}/raw/results.json`;
    return { h, path, saved: JSON.parse(h.files[path] as string) as SavedResults };
  }

  it('M3.5 a run the judge could not score is left out of the means, counted and named', async () => {
    const { h, saved } = await roundWithBrokenCase('4');
    const variant = saved.variants[0];
    const broken = variant?.runs.find((r) => r.caseId === BROKEN);
    expect(broken?.rubric).toBeUndefined();
    expect(broken?.rubricJudge).toMatchObject({
      attempts: 2,
      error: `judge incomplete: scored 0 of ${broken?.report.scenarios.length} scenarios in two attempts`,
    });
    expect(broken?.rubricJudge?.costUsd).toBeCloseTo(2 * RUBRIC_COST, 12);
    expect(broken?.grade?.pass).toBe(true); // the deterministic grade is untouched

    // The mean is over the two scored reports (1.5 each), not pulled down to (1.5 + 1.5 + 0.75) / 3.
    expect(variant?.rubric).toMatchObject({ judged: 2, overall: 1.5, scenarioScore: 1.5 });
    expect(unscoredReports(variant?.runs ?? [])).toEqual([`${BROKEN}#1 (${broken?.rubricJudge?.error})`]);

    expect(h.out()).toContain(`${BROKEN}#1: pass, judge failed ($`);
    expect(h.out()).toContain(
      `1 report(s) have no rubric score and are left out of the rubric means: ${BROKEN}#1 (judge incomplete: scored 0 of`,
    );
    expect(h.out()).toMatch(
      /Score only those again with: --rejudge \S+results\.json --cases coupon-expiry-missing/,
    );

    const summary = h.files['evals/rounds/4/summary.md'] as string;
    expect(summary).toContain(
      `Rubric means cover 2 of 3 reports. Left out, no usable judge score: ${BROKEN}#1 (judge incomplete`,
    );
    expect(summary).toContain('| Tickets | Scored | Cost |');
    expect(summary).toMatch(
      /\| coupon-expiry-missing \| synthetic \| — \| — \| — \| pass \| partial \| — \| \d+ \| — \| \$/,
    );
    expect(summary).toMatch(
      /\| rbac-export-role \| synthetic \| 1\.50 \| 1\.50 \| 1\.50 \| pass \| \S+ \| — \| (\d+) \| \1\/\1 \| \$/,
    );

    const [record] = JSON.parse(h.files['evals/rounds/index.json'] as string) as RoundRecord[];
    expect(record?.variants[0]).toMatchObject({ runs: 3, judged: 2, overall: 1.5 });
    expect(record?.variants[0]?.unscored).toEqual([`${BROKEN}#1 (${broken?.rubricJudge?.error})`]);
    expect(Object.keys(record?.variants[0]?.caseOverall ?? {}).sort()).toEqual([
      'rbac-export-role#1',
      'report-timezone#1',
    ]);
    expect(h.files['evals/ROUNDS.md']).toContain('| 1.50 (2/3) | 1.50 |');
    expect(unscoredNote(variant?.runs ?? [], 'r.json')[1]).toBe(
      `Score only those again with: --rejudge r.json --cases ${BROKEN}`,
    );
  });

  it('M3.5 --rejudge --cases scores only the named report again and updates the file in place, with a backup', async () => {
    const { h, path, saved } = await roundWithBrokenCase('4');
    await runEvals(['--round', '4', '--decision', 'keep'], h.deps);
    const original = h.files[path] as string;
    const forbidden = (): never => {
      throw new Error('a re-judge must not generate reports');
    };
    const shared = {
      writeFile: h.deps.writeFile,
      readFile: h.deps.readFile,
      createEngine: forbidden,
      createProvider: forbidden,
    };

    // Plan only: nothing is written.
    const plan = harness(shared);
    const planned = await runEvals(['--rejudge', path, '--cases', BROKEN, '--round', '4'], plan.deps);
    expect(planned).toMatchObject({ exitCode: 0, executed: false });
    expect(plan.out()).toContain(`reports to judge: 1 (only ${BROKEN}; the other reports keep their scores)`);
    expect(plan.out()).toContain(
      `${path} is updated in place; the original is copied to ${path}.bak-<time> first`,
    );
    expect(plan.out()).toContain('the record of round 4 is updated with the new scores');
    expect(planned.estimateUsd).toBeLessThan(0.1);
    expect(h.files[path]).toBe(original);
    expect(plan.createRubricClient).not.toHaveBeenCalled();

    const bodies: RubricBody[] = [];
    const fix = harness({ ...shared, createRubricClient: () => fakeRubricClient(0, bodies) });
    const outcome = await runEvals(['--rejudge', path, '--cases', BROKEN, '--round', '4', '--yes'], fix.deps);
    expect(outcome).toMatchObject({ exitCode: 0, executed: true });
    expect(bodies).toHaveLength(1); // one report, one judge call
    expect(outcome.resultsPath).toBe(path);

    const backup = Object.keys(h.files).find((f) => f.startsWith(`${path}.bak-`)) as string;
    expect(backup).toMatch(/results\.json\.bak-2026-11-12T09-\d\d-\d\d-000Z$/);
    expect(h.files[backup]).toBe(original);

    const updated = JSON.parse(h.files[path] as string) as SavedResults;
    expect(updated.rejudgedFrom).toBeUndefined(); // still the round's own results, not a re-scored copy
    expect(updated.rejudgedCases).toEqual([
      { at: expect.stringMatching(/^2026-11-12T09:/), cases: [BROKEN], judgeModel: 'claude-sonnet-5-5' },
    ]);
    const before = saved.variants[0]?.runs ?? [];
    const after = updated.variants[0]?.runs ?? [];
    for (const run of after) {
      const old = before.find((r) => r.caseId === run.caseId);
      if (run.caseId === BROKEN) {
        expect(run.rubric).toMatchObject({ rubricVersion: 2, scenarioScore: 1.5, overall: 1.5 });
        expect(run.rubricJudge).toMatchObject({ costUsd: RUBRIC_COST });
        expect(run.rubricJudge?.error).toBeUndefined();
      } else {
        expect(run.rubric).toEqual(old?.rubric); // untouched
        expect(run.rubricJudge).toEqual(old?.rubricJudge);
      }
      expect(run.report).toEqual(old?.report);
    }
    expect(updated.variants[0]?.rubric).toMatchObject({ judged: 3, overall: 1.5 });

    // The round's own record and summary are updated; the decision and the change text stay.
    const records = JSON.parse(h.files['evals/rounds/index.json'] as string) as RoundRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      round: 4,
      decision: 'keep',
      change: 'broken judge',
      rubricVersion: 2,
    });
    expect(records[0]?.rejudged).toBeUndefined();
    expect(records[0]?.variants[0]).toMatchObject({ judged: 3 });
    expect(records[0]?.variants[0]?.unscored).toBeUndefined();
    const summary = h.files['evals/rounds/4/summary.md'] as string;
    expect(summary).not.toContain('Rubric means cover');
    expect(summary).toContain('## Compared with the last kept round');
    expect(h.files['evals/ROUNDS.md']).toContain('| 1.50 | 1.50 |');
    expect(h.files['evals/ROUNDS.md']).not.toContain('(2/3)');
    expect(fix.out()).toContain(`${path} updated; the original is in ${backup}`);
    expect(Object.keys(h.files).filter((f) => f.includes('rubric-v'))).toEqual([]);
  });

  it('M3.5 --rejudge --cases refuses a file with older scores and a case the file does not hold', async () => {
    const { h, path, saved } = await roundWithBrokenCase('4');
    const shared = { writeFile: h.deps.writeFile, readFile: h.deps.readFile };
    const absent = harness(shared);
    expect(
      await runEvals(['--rejudge', path, '--cases', 'search-page-cap', '--yes'], absent.deps),
    ).toMatchObject({ exitCode: 2 });
    expect(absent.out()).toBe(`Cannot re-judge: ${path} has no run for search-page-cap.`);

    delete saved.rubricVersion;
    h.files['v1.json'] = JSON.stringify(saved);
    const old = harness(shared);
    expect(await runEvals(['--rejudge', 'v1.json', '--cases', BROKEN, '--yes'], old.deps)).toMatchObject({
      exitCode: 2,
    });
    expect(old.out()).toBe(
      'Cannot re-judge only some cases: v1.json holds scores from before rubric versions were recorded, and mixing them with rubric v2 scores would make the file meaningless. Re-judge the whole file first, without --cases.',
    );
    expect(old.createRubricClient).not.toHaveBeenCalled();
    expect(Object.keys(h.files).filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});

describe('comparing rounds when a report has no judge score (M3.5)', () => {
  const variant = (
    caseOverall: Record<string, number>,
    overrides: Partial<RoundVariant> = {},
  ): RoundVariant => {
    const values = Object.values(caseOverall);
    return {
      label: 'claude-opus-5-5 · high',
      runs: 3,
      errors: 0,
      overall: values.reduce((a, b) => a + b, 0) / values.length,
      scenarioScore: 1.5,
      reportScore: 1.5,
      graded: 3,
      passRate: 1,
      alignmentAccuracy: 1,
      findingRecall: 1,
      injectionFlagged: '0/0',
      judged: values.length,
      caseOverall,
      costUsd: 1,
      judgeCostUsd: 0.1,
      ...overrides,
    };
  };
  const round = (n: number, v: RoundVariant, decision: RoundRecord['decision'] = 'pending'): RoundRecord => ({
    round: n,
    date: '2026-11-12T09:00:00.000Z',
    promptVersion: 'p',
    change: `change ${n}`,
    split: 'dev',
    judgeModel: 'claude-sonnet-5-5',
    rubricVersion: 2,
    variants: [v],
    decision,
  });

  it('M3.5 the overall is compared on the reports both rounds scored', () => {
    // Round 1 scored all three; in round 2 the judge returned nothing usable for "c".
    const kept = round(1, variant({ 'a#1': 1.6, 'b#1': 1.6, 'c#1': 1.0 }), 'keep');
    const next = round(2, variant({ 'a#1': 1.7, 'b#1': 1.7 }));
    // Unpaired, 1.70 against 1.40 would look like +0.30; on the shared reports it is 1.70 against 1.60.
    const result = compareWithLastKept(next, [kept]);
    expect(result.rows[0]).toMatchObject({ metric: 'Overall', before: 1.6, after: 1.7, change: 'up' });
    expect(result.recommendation).toBe('keep');
    expect(result.reason).toBe(
      "The dev overall rose and no deterministic metric fell. The overall is compared on the 2 of 3 reports that both rounds scored; the per-criterion rows are each round's own means.",
    );
    expect(formatComparison(2, result)).toContain(
      '| claude-opus-5-5 · high | Overall | 1.60 | 1.70 | +0.10 |',
    );

    // The reverse: the missing report was the weak one, so the unpaired mean hides a fall.
    const better = round(1, variant({ 'a#1': 1.8, 'b#1': 1.8, 'c#1': 0.8 }), 'keep');
    const worse = compareWithLastKept(round(2, variant({ 'a#1': 1.7, 'b#1': 1.7 })), [better]);
    expect(worse.rows[0]).toMatchObject({ before: 1.8, after: 1.7, change: 'down' });
    expect(worse.recommendation).toBe('revert');
  });

  it('M3.5 with the same reports on both sides nothing changes, and records without per-report scores fall back', () => {
    const kept = round(1, variant({ 'a#1': 1.5, 'b#1': 1.5, 'c#1': 1.5 }), 'keep');
    const same = compareWithLastKept(round(2, variant({ 'a#1': 1.8, 'b#1': 1.5, 'c#1': 1.5 })), [kept]);
    expect(same.rows[0]?.before).toBeCloseTo(1.5, 9);
    expect(same.rows[0]?.after).toBeCloseTo(1.6, 9);
    expect(same.reason).toBe('The dev overall rose and no deterministic metric fell.');

    const { caseOverall: _c, ...older } = variant({ 'a#1': 1.4 });
    const fallback = compareWithLastKept(round(2, variant({ 'a#1': 1.7, 'b#1': 1.7 })), [
      round(1, older, 'keep'),
    ]);
    expect(fallback.rows[0]).toMatchObject({ before: 1.4, after: 1.7 });
    expect(fallback.reason).not.toContain('both rounds scored');

    // No report in common: there is nothing to compare.
    const disjoint = compareWithLastKept(round(2, variant({ 'x#1': 1.7 })), [kept]);
    expect(disjoint.rows[0]).toMatchObject({ before: null, after: null, change: 'n/a' });
    expect(disjoint.recommendation).toBe('none');
  });
});

describe('the whole dev split still averages over every scored report (M3.5)', () => {
  it('M3.5 a healthy judge scores every report once, with no retries', async () => {
    const h = harness();
    const outcome = await runEvals(['--yes', '--judge'], h.deps);
    expect(h.rubricBodies).toHaveLength(DEV.length);
    expect(outcome.variants?.[0]?.rubric?.judged).toBe(DEV.length);
    expect(outcome.variants?.[0]?.runs.every((r) => r.rubricJudge?.attempts === undefined)).toBe(true);
    expect(h.out()).not.toContain('have no rubric score');
  });
});
