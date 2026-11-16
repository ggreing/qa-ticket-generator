/**
 * Plan phase: spec -> the full QA case sheet (SPEC v3 §2.1, §3.1, §6).
 *
 * The requirements are covered a few per call, because one call for a whole spec would be cut
 * off: a requirement yields several cases and a case is a few hundred output tokens. The calls
 * share the system text and the spec block (cached). A last, small call looks at an index of all
 * cases and decides duplicates and priorities; it never rewrites a case, so it cannot lose one.
 *
 * Cost guard (v2 LLM-10): every call is estimated up front. While the estimate exceeds
 * `maxCostUsd`, the last requirement group is left out and reported; when even the first group is
 * over, nothing is sent and the run fails with `cost_cap`. Once actual spend reaches the cap, no
 * further call starts.
 * Owner: qa-work-session-c(fable).
 */
import { z } from 'zod';
import {
  type PlannedCase,
  type PlanRequest,
  type PlanResult,
  type Priority,
  TECHNIQUES,
} from '../core/cases';
import type { LlmProvider, LlmUsage, Warning } from '../core/contracts';
import { QtgError } from '../core/errors';
import { MAP_CONCURRENCY } from '../core/limits';
import { type PlanOutput, PlanOutputSchema, Priority as PrioritySchema } from '../core/schema';
import {
  buildMergeTail,
  buildPlanPrefix,
  buildPlanTask,
  type IndexedCase,
  PLAN_MERGE_SYSTEM,
  PLAN_SYSTEM,
  planLanguageBlock,
  type Requirement,
  requirementsOf,
} from './prompts/plan';
import { asStructured, type StructuredProvider } from './structured';
import { addUsage, usageFromError, withBilledUsage, ZERO_USAGE } from './usage';

/** Requirements per call. Three yields roughly 15–25 cases, well inside one response. */
export const AC_GROUP_SIZE = 3;
/** Output the merge call is expected to write: a few index numbers per decision. */
const MERGE_OUTPUT_TOKENS = 2_000;
/** Rough size of one row of the case index shown to the merge call (title, setup, first result). */
const INDEX_ROW_TOKENS = 110;
/** Longest setup text shown per case in the merge index. */
const INDEX_SETUP_CHARS = 240;
/** Cases a group is expected to produce, for sizing the merge call before any call is made. */
const EXPECTED_CASES_PER_REQUIREMENT = 14;
const CHARS_PER_TOKEN = 3.2;
const PRIORITY_ORDER: Readonly<Record<Priority, number>> = { P0: 0, P1: 1, P2: 2 };

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** What the merge call returns: decisions about the index, never case text. */
export const PlanMergeSchema = z.object({
  duplicates: z
    .array(
      z.object({
        reason: z
          .string()
          .describe(
            'One sentence: the setup, action and observation these cases share. Written before choosing.',
          ),
        keep: z.number().describe('Index of the case to keep.'),
        drop: z.array(z.number()).describe('Indexes of the cases that duplicate it.'),
      }),
    )
    .describe('Groups of cases a tester would treat as the same check. Empty when there are none.'),
  priorities: z
    .array(z.object({ index: z.number(), priority: PrioritySchema }))
    .describe('Only the cases whose priority should change.'),
});
export type PlanMerge = z.infer<typeof PlanMergeSchema>;

export interface PlanRunPlan {
  requirements: Requirement[];
  /** Requirement groups that will be sent, in order. A single empty group means "whole spec". */
  groups: Requirement[][];
  /** Groups left out because the estimate exceeded the cap. */
  skipped: Requirement[][];
  /** Whether a merge call follows (more than one group). */
  merge: boolean;
  estimateUsd: number;
}

/**
 * The pre-call plan of a plan run: how the requirements are grouped, what the calls are estimated
 * to cost, and which groups the cost cap leaves out. Pure; the eval runner uses it to quote a run.
 */
export function planPlanRun(
  req: PlanRequest,
  provider: Pick<LlmProvider, 'estimateCostUsd'>,
  options: { maxCostUsd: number; expectedOutputTokens: number },
): PlanRunPlan {
  const requirements = requirementsOf(req.spec);
  const all: Requirement[][] = [];
  // As few calls as the group size allows, with the requirements spread evenly over them, so no
  // call is left with a single requirement while another carries three.
  const groupCount = Math.ceil(requirements.length / AC_GROUP_SIZE);
  for (let g = 0, i = 0; g < groupCount; g++) {
    const size = Math.ceil((requirements.length - i) / (groupCount - g));
    all.push(requirements.slice(i, i + size));
    i += size;
  }
  if (all.length === 0) all.push([]);

  const prefix = buildPlanPrefix(req, requirements).join('\n');
  const shared = estimateTokens(PLAN_SYSTEM + planLanguageBlock(req.language) + prefix);
  const cost = (inputTokens: number, outputTokens: number): number =>
    provider.estimateCostUsd({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const estimate = (groups: Requirement[][]): number => {
    const calls = groups.reduce(
      (sum, g) =>
        sum + cost(shared + estimateTokens(buildPlanTask(g, requirements)), options.expectedOutputTokens),
      0,
    );
    if (groups.length < 2) return calls;
    const cases = groups.reduce((n, g) => n + g.length, 0) * EXPECTED_CASES_PER_REQUIREMENT;
    const mergeInput = estimateTokens(PLAN_MERGE_SYSTEM + prefix) + cases * INDEX_ROW_TOKENS;
    return calls + cost(mergeInput, MERGE_OUTPUT_TOKENS);
  };

  let groups = all;
  while (groups.length > 1 && estimate(groups) > options.maxCostUsd) groups = groups.slice(0, -1);
  return {
    requirements,
    groups,
    skipped: all.slice(groups.length),
    merge: groups.length > 1,
    estimateUsd: estimate(groups),
  };
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cleanList = (items: string[]): string[] => items.map(clean).filter((item) => item !== '');
/** A title without the labels the renderer adds itself: "[P0][boundary] title" -> "title". */
const bareTitle = (title: string): string => clean(title).replace(/^(?:\[[^\]]{1,24}\]\s*)+/, '');
const key = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Turns one call's raw output into cases: trimmed, without empty lines, with labels that exist in
 * the spec, and with `reuseCaseId` kept only when it names an existing case not yet claimed.
 */
export function normalizePlanned(
  output: PlanOutput,
  requirements: Requirement[],
  existingIds: ReadonlySet<string>,
  claimed: Set<string>,
): PlannedCase[] {
  const known = new Map(requirements.map((r) => [r.label.toUpperCase(), r.label]));
  const cases: PlannedCase[] = [];
  for (const raw of output.cases) {
    const title = bareTitle(raw.title);
    const steps = cleanList(raw.steps);
    const expected = cleanList(raw.expected);
    // A row with nothing to do or nothing to observe is not a test case.
    if (title === '' || steps.length === 0 || expected.length === 0) continue;
    const labels = cleanList(raw.acLabels);
    const acLabels =
      known.size === 0
        ? labels
        : [
            ...new Set(
              labels
                .map((l) => known.get(l.toUpperCase().replace(/[\s-]/g, '')))
                .filter((l): l is string => !!l),
            ),
          ];
    let reuseCaseId = raw.reuseCaseId ? raw.reuseCaseId.trim() : null;
    if (reuseCaseId !== null && (!existingIds.has(reuseCaseId) || claimed.has(reuseCaseId)))
      reuseCaseId = null;
    if (reuseCaseId !== null) claimed.add(reuseCaseId);
    cases.push({
      title,
      acLabels,
      technique: TECHNIQUES.includes(raw.technique) ? raw.technique : 'happy_path',
      priority: raw.priority,
      preconditions: cleanList(raw.preconditions),
      testData: cleanList(raw.testData),
      steps,
      expected,
      // A happy path is the requirement as written: the spec states it, so it has no gap to name.
      whyEasyToMiss: raw.technique === 'happy_path' ? '' : clean(raw.whyEasyToMiss),
      origin: 'spec',
      reuseCaseId,
    });
  }
  return cases;
}

/** Drops a case whose title and technique repeat an earlier one word for word, and records it. */
function dropExactRepeats(cases: PlannedCase[], record: MergedAway[]): PlannedCase[] {
  const seen = new Map<string, PlannedCase>();
  return cases.filter((c) => {
    const k = `${c.technique}|${key(c.title)}`;
    const first = seen.get(k);
    if (first) {
      record.push({
        title: c.title,
        acLabels: c.acLabels,
        technique: c.technique,
        priority: c.priority,
        keptTitle: first.title,
        by: 'exact',
      });
      return false;
    }
    seen.set(k, c);
    return true;
  });
}

/** A case the merge step removed, with the case it was judged to repeat. */
export interface MergedAway {
  title: string;
  acLabels: string[];
  technique: string;
  priority: Priority;
  /** Title of the case that stays in its place. */
  keptTitle: string;
  /** `exact`: same technique and title, dropped in code. `merge`: called a duplicate by the merge call. */
  by: 'exact' | 'merge';
  /** The merge call's own sentence on what the two cases share. Absent for `exact`. */
  reason?: string;
}

/**
 * What happened between the group calls and the final sheet. Not part of the core `PlanResult`
 * contract; the eval harness records it to watch for a merge that removes a real case.
 */
export interface PlanDiagnostics {
  /** Cases the group calls returned, after normalization. */
  generated: number;
  /** Cases left after exact repeats and merge duplicates were removed (before the max-cases cut). */
  afterMerge: number;
  mergedAway: MergedAway[];
  /** Cases whose priority the merge call changed. */
  priorityChanges: number;
  /** False when there was one group, or the merge call failed or was skipped by the cost cap. */
  mergeRan: boolean;
  /** Duplicate groups the merge call named without saying what the cases share; they were not applied. */
  unexplainedGroups: number;
}

/**
 * Applies the merge call's decisions. Indexes outside the sheet are ignored, a case named both as
 * kept and as dropped is kept, and a dropped case hands its existing id to the case that stays.
 * A duplicate group that does not say what its cases share is not applied: removing a case needs
 * a reason someone can check.
 */
export function applyMerge(cases: PlannedCase[], merge: PlanMerge): PlannedCase[] {
  return applyMergeDetailed(cases, merge).cases;
}

/** `applyMerge` plus the record of what it removed and how many priorities it changed. */
export function applyMergeDetailed(
  cases: PlannedCase[],
  merge: PlanMerge,
): { cases: PlannedCase[]; mergedAway: MergedAway[]; priorityChanges: number; unexplainedGroups: number } {
  const valid = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < cases.length;
  const explained = merge.duplicates.filter((d) => clean(d.reason ?? '') !== '');
  const unexplainedGroups = merge.duplicates.length - explained.length;
  const kept = new Set(explained.map((d) => d.keep).filter(valid));
  const next = cases.map((c) => ({ ...c }));
  const dropped = new Set<number>();
  const mergedAway: MergedAway[] = [];
  let priorityChanges = 0;
  for (const group of explained) {
    if (!valid(group.keep)) continue;
    for (const i of group.drop) {
      if (!valid(i) || i === group.keep || kept.has(i) || dropped.has(i)) continue;
      dropped.add(i);
      const keeper = next[group.keep] as PlannedCase;
      const gone = next[i] as PlannedCase;
      mergedAway.push({
        title: gone.title,
        acLabels: gone.acLabels,
        technique: gone.technique,
        priority: gone.priority,
        keptTitle: keeper.title,
        by: 'merge',
        reason: clean(group.reason),
      });
      if (keeper.reuseCaseId === null && gone.reuseCaseId !== null) keeper.reuseCaseId = gone.reuseCaseId;
      keeper.acLabels = [...new Set([...keeper.acLabels, ...gone.acLabels])];
    }
  }
  for (const change of merge.priorities) {
    if (!valid(change.index)) continue;
    const target = next[change.index] as PlannedCase;
    if (target.priority !== change.priority && !dropped.has(change.index)) priorityChanges++;
    target.priority = change.priority;
  }
  return { cases: next.filter((_, i) => !dropped.has(i)), mergedAway, priorityChanges, unexplainedGroups };
}

async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * SPEC v3 §2.1 — writes the QA cases of a spec.
 *
 * A failed run rejects with a QtgError whose `usage` is everything billed up to that point.
 */
export async function generatePlan(
  req: PlanRequest,
  provider: LlmProvider,
  options: { maxCostUsd: number; expectedOutputTokens: number },
  signal: AbortSignal,
): Promise<PlanResult & { diagnostics: PlanDiagnostics }> {
  const llm: StructuredProvider = asStructured(provider);
  const plan = planPlanRun(req, provider, options);
  const warnings: Warning[] = [];
  if (plan.estimateUsd > options.maxCostUsd) {
    // The cap is a hard limit (SPEC G4): nothing is sent to the model.
    throw new QtgError(
      'cost_cap',
      `The estimated cost of writing cases for even the first requirements (~$${plan.estimateUsd.toFixed(2)}) exceeds max-cost-usd ($${options.maxCostUsd.toFixed(2)}), so nothing was generated. Raise max-cost-usd.`,
    );
  }

  const { requirements } = plan;
  const system = [PLAN_SYSTEM, planLanguageBlock(req.language)];
  const prefix = buildPlanPrefix(req, requirements);
  const existingIds = new Set(req.existing.map((c) => c.caseId));
  const claimed = new Set<string>();
  let usage: LlmUsage = ZERO_USAGE;
  let calls = 0;
  const spent = (): number => provider.estimateCostUsd(usage);
  const perGroup: PlannedCase[][] = plan.groups.map(() => []);
  const capped: Requirement[][] = [];
  let failure: unknown;

  /** One group; a reply that was cut off is retried as two halves, since a smaller part fits. */
  const runGroup = async (group: Requirement[]): Promise<PlanOutput['cases']> => {
    try {
      calls++;
      const result = await llm.generateStructured<PlanOutput>(
        {
          system,
          prefix,
          tail: buildPlanTask(group, requirements),
          schema: PlanOutputSchema,
          sharePrefix: plan.groups.length > 1,
          what: 'QA case',
          subject: 'spec',
        },
        signal,
      );
      usage = addUsage(usage, result.usage);
      return result.value.cases;
    } catch (err) {
      usage = addUsage(usage, usageFromError(err));
      if (!(err instanceof QtgError) || err.code !== 'llm_truncated' || group.length < 2) throw err;
      const half = Math.ceil(group.length / 2);
      return [...(await runGroup(group.slice(0, half))), ...(await runGroup(group.slice(half)))];
    }
  };

  await pool(plan.groups, MAP_CONCURRENCY, async (group, index) => {
    if (failure) return;
    if (index > 0 && spent() >= options.maxCostUsd) {
      capped.push(group);
      return;
    }
    try {
      const raw = await runGroup(group);
      perGroup[index] = normalizePlanned({ cases: raw }, requirements, existingIds, claimed);
    } catch (err) {
      failure ??= err;
    }
  });
  if (failure) throw withBilledUsage(failure, usage);

  const leftOut = [...capped, ...plan.skipped];
  if (leftOut.length > 0) {
    const labels = leftOut.flat().map((r) => r.label);
    warnings.push({
      code: 'cost_cap',
      message: `No cases were written for ${labels.join(', ')} because ${capped.length > 0 ? 'the run reached' : 'the estimated cost exceeded'} max-cost-usd ($${options.maxCostUsd.toFixed(2)}).`,
    });
  }

  const generated = perGroup.flat();
  const mergedAway: MergedAway[] = [];
  let priorityChanges = 0;
  let unexplainedGroups = 0;
  let mergeRan = false;
  let cases = dropExactRepeats(generated, mergedAway);

  // ── merge: duplicates across groups and priorities over the whole sheet ─────
  if (plan.merge && cases.length > 1 && spent() < options.maxCostUsd) {
    const index: IndexedCase[] = cases.map((c, i) => ({
      index: i,
      acLabels: c.acLabels,
      technique: c.technique,
      priority: c.priority,
      title: c.title,
      setup: [...c.preconditions, ...c.testData].join('; ').slice(0, INDEX_SETUP_CHARS),
      expected: c.expected[0] ?? '',
    }));
    try {
      calls++;
      const merged = await llm.generateStructured<PlanMerge>(
        {
          system: [PLAN_MERGE_SYSTEM],
          prefix: [prefix[0] as string],
          tail: buildMergeTail(index),
          schema: PlanMergeSchema,
          what: 'merge',
          subject: 'spec',
        },
        signal,
      );
      usage = addUsage(usage, merged.usage);
      const applied = applyMergeDetailed(cases, merged.value);
      cases = applied.cases;
      mergedAway.push(...applied.mergedAway);
      priorityChanges = applied.priorityChanges;
      unexplainedGroups = applied.unexplainedGroups;
      mergeRan = true;
    } catch (err) {
      // The cases are complete without the merge; keep them and say what was skipped.
      usage = addUsage(usage, usageFromError(err));
      if (err instanceof QtgError && err.code === 'cancelled') throw withBilledUsage(err, usage);
      warnings.push({
        code: 'other',
        message:
          'Duplicate removal and priority re-ranking across requirement groups were skipped because the merge call failed.',
      });
    }
  }

  const afterMerge = cases.length;

  // ── order and safety cap (§6): P0 first; over the cap, P2 goes first ────────
  cases = cases
    .map((c, i) => ({ c, i }))
    .sort((a, b) => PRIORITY_ORDER[a.c.priority] - PRIORITY_ORDER[b.c.priority] || a.i - b.i)
    .map(({ c }) => c);
  const dropped = Math.max(0, cases.length - req.maxCases);
  if (dropped > 0) {
    const cut = cases.slice(req.maxCases);
    const counts = (['P0', 'P1', 'P2'] as const)
      .map((p) => [p, cut.filter((c) => c.priority === p).length] as const)
      .filter(([, n]) => n > 0)
      .map(([p, n]) => `${n} ${p}`);
    warnings.push({
      code: 'other',
      message: `${dropped} lowest-priority case(s) were left out because of max-cases (${req.maxCases}): ${counts.join(', ')}.`,
    });
    cases = cases.slice(0, req.maxCases);
  }

  const costUsd = spent();
  if (costUsd > options.maxCostUsd && leftOut.length === 0) {
    warnings.push({
      code: 'cost_cap',
      message: `The run cost about $${costUsd.toFixed(2)}, above max-cost-usd ($${options.maxCostUsd.toFixed(2)}).`,
    });
  }
  return {
    cases,
    usage,
    costUsd,
    calls,
    warnings,
    dropped,
    diagnostics: {
      generated: generated.length,
      afterMerge,
      mergedAway,
      priorityChanges,
      mergeRan,
      unexplainedGroups,
    },
  };
}
