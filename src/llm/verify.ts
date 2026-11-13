/**
 * Verify phase: cases + PR code -> code status per case, code-derived cases, requirement
 * alignment (SPEC v3 §2.2).
 *
 * Calls. A change that fits one chunk and a sheet of up to MAX_CASES_PER_CALL cases is one call,
 * which is the usual pull request. Otherwise there is one call per (code chunk, case batch). The
 * system text and the spec are shared by all of them; the case batch is shared by the calls of
 * that batch. Only the first batch of each chunk is asked for new cases and findings.
 *
 * No merge call. The answers are combined in code, by the rule the v2 merge prompt stated: a
 * contradiction anywhere stands, an implementation anywhere counts, "missing" holds only when no
 * part found the behavior, and what nobody could see stays unknown.
 *
 * Cost guard (v2 LLM-10): estimate first; while over `maxCostUsd` the lowest-priority chunk is
 * left out and reported; when the first chunk alone is over, nothing is sent (`cost_cap`); once
 * the spend reaches the cap no further call starts.
 * Owner: qa-work-session-c(fable).
 */
import {
  type CaseDraft,
  type CodeStatus,
  type QaCase,
  TECHNIQUES,
  type VerifyRequest,
  type VerifyResult,
} from '../core/cases';
import type { CodeChunk, LlmProvider, LlmUsage, SkippedFile, Warning } from '../core/contracts';
import { QtgError } from '../core/errors';
import { MAP_CONCURRENCY } from '../core/limits';
import { type QaReport, type VerifyOutput, VerifyOutputSchema } from '../core/schema';
import { planLanguageBlock, type Requirement, requirementsOf } from './prompts/plan';
import {
  buildCaseIndex,
  buildScopeBlock,
  buildVerifyPrefix,
  buildVerifyTail,
  VERIFY_SYSTEM,
} from './prompts/verify';
import {
  type OutOfScopeReason,
  outOfScope,
  type RejudgeReason,
  type ResolvedScope,
  resolveScope,
  selectCasesToJudge,
} from './scope';
import { asStructured } from './structured';
import { addUsage, usageFromError, withBilledUsage, ZERO_USAGE } from './usage';

/** Cases judged in one call. A status is about 70 output tokens, so 60 stay far from the limit. */
export const MAX_CASES_PER_CALL = 60;
const STATUS_OUTPUT_TOKENS = 70;
const NEW_CASE_OUTPUT_TOKENS = 400;
/** Findings and JSON overhead of the call that also writes new cases. */
const FINDINGS_OUTPUT_TOKENS = 1_500;
const CHARS_PER_TOKEN = 3.2;
const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

type Findings = QaReport['prdAlignment'];
type Finding = Findings['findings'][number];

/** Which answer wins when parts disagree about a case. */
const STATUS_RANK: Readonly<Record<CodeStatus, number>> = {
  contradicts: 3,
  implemented: 2,
  missing: 1,
  unknown: 0,
};
const FINDING_RANK: Readonly<Record<Finding['status'], number>> = {
  contradicts: 3,
  covered: 2,
  missing: 1,
  unclear: 0,
};
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 } as const;

interface Call {
  chunk: CodeChunk;
  batch: QaCase[];
  batchIndex: number;
  withCodeCases: boolean;
}

export interface VerifyRunPlan {
  /** The cases that get a status in this run, split into batches of at most MAX_CASES_PER_CALL. */
  batches: QaCase[][];
  /** Active cases that keep the status they have (only after the first check of a pull request). */
  kept: QaCase[];
  /** Why the cases in `batches` are judged; null on a first check, when every case is. */
  rejudgeReasons: Record<RejudgeReason, number> | null;
  /** The lines pushed since the last check, resolved against the chunks that are judged. */
  scope: ResolvedScope | null;
  /** Chunks that will be judged, highest priority first. */
  chunks: CodeChunk[];
  /** Chunks left out because the estimate exceeded the cap. */
  dropped: CodeChunk[];
  calls: number;
  estimateUsd: number;
}

/** Expected output of one call: a status per case, plus new cases and findings when asked for. */
const expectedOutput = (
  cases: number,
  withCodeCases: boolean,
  maxNewCases: number,
  ceiling: number,
): number =>
  Math.min(
    ceiling,
    cases * STATUS_OUTPUT_TOKENS +
      (withCodeCases ? FINDINGS_OUTPUT_TOKENS + maxNewCases * NEW_CASE_OUTPUT_TOKENS : 300),
  );

/**
 * The pre-call plan of a verify run: case batches, the chunks the cost cap allows, the number of
 * calls and what they are estimated to cost. Pure; the eval runner uses it to quote a run.
 */
export function planVerifyRun(
  req: VerifyRequest,
  provider: Pick<LlmProvider, 'estimateCostUsd'>,
  options: { maxCostUsd: number; expectedOutputTokens: number },
): VerifyRunPlan {
  const active = req.cases.filter((c) => c.lifecycle === 'active');
  const requirements = requirementsOf(req.spec);
  const system = estimateTokens(VERIFY_SYSTEM + planLanguageBlock(req.language));
  const prPaths = new Set<string>([
    ...req.pre.chunks.flatMap((c) => c.files.map((f) => f.path)),
    ...req.pre.skipped.map((s) => s.path),
  ]);
  const cost = (inputTokens: number, outputTokens: number): number =>
    provider.estimateCostUsd({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

  /**
   * Everything that depends on which chunks are judged. A file in a chunk the cost cap leaves out
   * is not shown, so a case that rests on it cannot be judged again and keeps its status.
   */
  const layout = (chunks: CodeChunk[]) => {
    const scope = resolveScope(req.newCaseScope ?? null, chunks);
    const selection = selectCasesToJudge(active, scope, prPaths);
    const batches: QaCase[][] = [];
    for (let i = 0; i < selection.judge.length; i += MAX_CASES_PER_CALL)
      batches.push(selection.judge.slice(i, i + MAX_CASES_PER_CALL));
    if (batches.length === 0) batches.push([]);
    const prefixTokens = batches.map((batch) =>
      estimateTokens(buildVerifyPrefix(req, requirements, batch, scope !== null).join('\n')),
    );
    // The call that may write new cases also gets the index of the whole sheet. After the first
    // check every call gets the lines pushed since.
    const keptIds = scope ? new Set(selection.kept.map((c) => c.caseId)) : undefined;
    const indexTokens = estimateTokens(buildCaseIndex(active, keptIds));
    const estimateUsd = chunks.reduce((sum, chunk) => {
      const pushed = scope ? estimateTokens(buildScopeBlock(scope, chunk)) : 0;
      return (
        sum +
        batches.reduce(
          (s, batch, b) =>
            s +
            cost(
              system +
                (prefixTokens[b] as number) +
                chunk.estimatedTokens +
                pushed +
                (b === 0 ? indexTokens : 0),
              expectedOutput(batch.length, b === 0, req.maxNewCases, options.expectedOutputTokens),
            ),
          0,
        )
      );
    }, 0);
    return { scope, selection, batches, estimateUsd };
  };

  let chunks = req.pre.chunks;
  let current = layout(chunks);
  while (chunks.length > 1 && current.estimateUsd > options.maxCostUsd) {
    chunks = chunks.slice(0, -1);
    current = layout(chunks);
  }
  return {
    batches: current.batches,
    kept: current.selection.kept,
    rejudgeReasons: current.scope ? current.selection.reasons : null,
    scope: current.scope,
    chunks,
    dropped: req.pre.chunks.slice(chunks.length),
    calls: chunks.length * current.batches.length,
    estimateUsd: current.estimateUsd,
  };
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cleanList = (items: string[]): string[] => items.map(clean).filter((item) => item !== '');
const key = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const labelKey = (requirement: string): string => {
  const m = /^\s*([A-Za-z]{1,6}[- ]?\d{1,4}(?:\.\d{1,3})?)\s*(?:[:.)–—-]|$)/.exec(requirement);
  return m ? (m[1] as string).toUpperCase().replace(/[\s-]/g, '') : key(requirement);
};

/** A new case the model itself tied to an existing one, and what was done with it. */
export interface SameRisk {
  /** Title of the new case as the model wrote it. */
  title: string;
  /** The id the model named in `sameAsCaseId`. */
  sameAsCaseId: string;
  /** Title of that case; null when the id is not an active case of the sheet. */
  existingTitle: string | null;
}

/**
 * What happened to the new cases between the model's answers and the result. Not part of the core
 * `VerifyResult` contract; the eval harness records it.
 */
export interface VerifyDiagnostics {
  /** New cases dropped because the model named an existing case that covers the same risk. */
  sameRisk: SameRisk[];
  /** New cases kept although they named an id, because no active case has that id. */
  unknownSameAs: SameRisk[];
  /**
   * New cases dropped because the pull request was checked before and they do not come from the
   * lines pushed since. Empty on a first check.
   */
  outOfScope: { title: string; reason: OutOfScopeReason }[];
  /**
   * How many cases got a status in this run and how many kept the one they had. On a first check
   * every case is judged and `reasons` is null.
   */
  rejudge: { judged: number; kept: number; reasons: Record<RejudgeReason, number> | null };
  /**
   * Requirement findings that disagree with the statuses of that requirement's cases (the ones
   * given now and the ones kept). Reported, not corrected.
   */
  alignmentConflicts: {
    requirement: string;
    finding: Finding['status'];
    /** `case_not_met`: found covered while a case is missing or contradicts. `cases_all_met`: found missing or contradicting while every case is implemented. */
    kind: 'case_not_met' | 'cases_all_met';
    cases: { caseId: string; status: CodeStatus }[];
  }[];
}

/** A code-derived case as the model wrote it, cleaned; null when it is not a runnable case. */
function toCodeCase(
  raw: VerifyOutput['newCases'][number],
  labels: ReadonlyMap<string, string>,
): CaseDraft | null {
  const title = clean(raw.title).replace(/^(?:\[[^\]]{1,24}\]\s*)+/, '');
  const steps = cleanList(raw.steps);
  const expected = cleanList(raw.expected);
  if (title === '' || steps.length === 0 || expected.length === 0) return null;
  return {
    title,
    acLabels: [
      ...new Set(
        cleanList(raw.acLabels)
          .map((l) => labels.get(l.toUpperCase().replace(/[\s-]/g, '')))
          .filter((l): l is string => !!l),
      ),
    ],
    technique: TECHNIQUES.includes(raw.technique) ? raw.technique : 'failure',
    priority: raw.priority,
    preconditions: cleanList(raw.preconditions),
    testData: cleanList(raw.testData),
    steps,
    expected,
    whyEasyToMiss: clean(raw.whyEasyToMiss),
    origin: 'code',
  };
}

/**
 * Combines the answers of every call into one result (see the module comment for the rule).
 * `changedPaths` is every path of the pull request; a file reference outside it is dropped.
 *
 * A new case whose `sameAsCaseId` names an active case of the sheet is dropped: the model itself
 * says the risk is already there. An id that no active case has proves nothing, so that case is
 * kept and reported.
 *
 * With a `scope` (the pull request was checked before), a new case that does not come from the
 * lines pushed since is dropped as well; `outOfScope` in scope.ts states the test.
 *
 * `judged` are the cases that were sent to be judged. Only they get a status in the result; the
 * other active cases keep the one they have, which the caller leaves untouched by not naming them.
 * Without it every active case was judged.
 */
export function combineVerify(
  outputs: VerifyOutput[],
  cases: QaCase[],
  requirements: Requirement[],
  changedPaths: ReadonlySet<string>,
  maxNewCases: number,
  scope: ResolvedScope | null = null,
  judged?: QaCase[],
): Pick<VerifyResult, 'statuses' | 'newCases' | 'alignment'> & { diagnostics: VerifyDiagnostics } {
  const files = (list: string[]): string[] => [
    ...new Set(list.map((f) => f.trim()).filter((f) => changedPaths.has(f))),
  ];

  // ── statuses: the strongest answer per case ─────────────────────────────────
  const best = new Map<string, VerifyResult['statuses'][number]>();
  const active = cases.filter((c) => c.lifecycle === 'active');
  const toJudge = judged ?? active;
  const known = new Set(toJudge.map((c) => c.caseId));
  for (const output of outputs) {
    for (const s of output.statuses) {
      const caseId = s.caseId.trim();
      if (!known.has(caseId)) continue; // not on the sheet, or not sent to be judged in this run
      const current = best.get(caseId);
      const next = { caseId, status: s.status, evidence: clean(s.evidence), files: files(s.files) };
      if (!current || STATUS_RANK[next.status] > STATUS_RANK[current.status]) {
        best.set(
          caseId,
          current ? { ...next, files: [...new Set([...next.files, ...current.files])] } : next,
        );
      } else if (STATUS_RANK[next.status] === STATUS_RANK[current.status]) {
        current.files = [...new Set([...current.files, ...next.files])];
        if (current.evidence === '') current.evidence = next.evidence;
      }
    }
  }
  // Every case that was sent gets a status; one the model skipped is unknown, not silently absent.
  const statuses = toJudge.map(
    (c) => best.get(c.caseId) ?? { caseId: c.caseId, status: 'unknown' as const, evidence: '', files: [] },
  );

  // ── new cases: once each, most important first ──────────────────────────────
  const labels = new Map(requirements.map((r) => [r.label.toUpperCase().replace(/[\s-]/g, ''), r.label]));
  const existingTitles = new Set(cases.map((c) => key(c.title)));
  // The ids the model was shown in the index: the active cases.
  const indexed = new Map(cases.filter((c) => c.lifecycle === 'active').map((c) => [c.caseId, c.title]));
  const diagnostics: VerifyDiagnostics = {
    sameRisk: [],
    unknownSameAs: [],
    outOfScope: [],
    rejudge: { judged: toJudge.length, kept: active.length - toJudge.length, reasons: null },
    alignmentConflicts: [],
  };
  const seen = new Set<string>();
  const newCases: CaseDraft[] = [];
  for (const output of outputs) {
    for (const raw of output.newCases) {
      const c = toCodeCase(raw, labels);
      if (!c) continue;
      const sameAs = (raw.sameAsCaseId ?? '').trim();
      if (sameAs !== '') {
        const existingTitle = indexed.get(sameAs) ?? null;
        if (existingTitle !== null) {
          diagnostics.sameRisk.push({ title: c.title, sameAsCaseId: sameAs, existingTitle });
          continue;
        }
        diagnostics.unknownSameAs.push({ title: c.title, sameAsCaseId: sameAs, existingTitle: null });
      }
      const reason = scope ? outOfScope(c, scope) : null;
      if (reason) {
        diagnostics.outOfScope.push({ title: c.title, reason });
        continue;
      }
      const k = key(c.title);
      if (seen.has(k) || existingTitles.has(k)) continue;
      seen.add(k);
      newCases.push(c);
    }
  }
  const ranked = newCases
    .map((c, i) => ({ c, i }))
    .sort((a, b) => PRIORITY_ORDER[a.c.priority] - PRIORITY_ORDER[b.c.priority] || a.i - b.i)
    .map(({ c }) => c)
    .slice(0, Math.max(0, maxNewCases));

  // ── alignment: one finding per requirement ──────────────────────────────────
  const merged = new Map<string, Finding>();
  for (const output of outputs) {
    for (const f of output.prdAlignment.findings) {
      const k = labelKey(f.requirement);
      const next: Finding = {
        ...f,
        requirement: clean(f.requirement),
        evidence: clean(f.evidence),
        files: files(f.files),
      };
      const current = merged.get(k);
      if (!current || FINDING_RANK[next.status] > FINDING_RANK[current.status]) {
        merged.set(k, current ? { ...next, files: [...new Set([...next.files, ...current.files])] } : next);
      } else if (FINDING_RANK[next.status] === FINDING_RANK[current.status]) {
        current.files = [...new Set([...current.files, ...next.files])];
      }
    }
  }
  const findings = [...merged.values()];
  const status: Findings['status'] =
    findings.length === 0
      ? (outputs[0]?.prdAlignment.status ?? 'partial')
      : findings.some((f) => f.status === 'contradicts')
        ? 'misaligned'
        : findings.every((f) => f.status === 'covered')
          ? 'aligned'
          : 'partial';
  // ── do the findings agree with the statuses of their cases? ─────────────────
  const finalStatus = new Map<string, CodeStatus>();
  for (const c of active) {
    const now = known.has(c.caseId) ? (best.get(c.caseId)?.status ?? 'unknown') : c.codeStatus?.status;
    if (now) finalStatus.set(c.caseId, now);
  }
  for (const f of findings) {
    const label = labelKey(f.requirement);
    const own = active
      .filter((c) => c.acLabels.some((l) => l.toUpperCase().replace(/[\s-]/g, '') === label))
      .flatMap((c) => {
        const s = finalStatus.get(c.caseId);
        return s ? [{ caseId: c.caseId, status: s }] : [];
      });
    if (own.length === 0) continue;
    const notMet = own.filter((c) => c.status === 'missing' || c.status === 'contradicts');
    if (f.status === 'covered' && notMet.length > 0) {
      diagnostics.alignmentConflicts.push({
        requirement: f.requirement,
        finding: f.status,
        kind: 'case_not_met',
        cases: notMet,
      });
    } else if (
      (f.status === 'missing' || f.status === 'contradicts') &&
      own.every((c) => c.status === 'implemented')
    ) {
      diagnostics.alignmentConflicts.push({
        requirement: f.requirement,
        finding: f.status,
        kind: 'cases_all_met',
        cases: own,
      });
    }
  }

  // Only a case that would have been kept is worth reporting as kept despite an unknown id.
  const keptTitles = new Set(newCases.map((c) => c.title));
  diagnostics.unknownSameAs = diagnostics.unknownSameAs.filter((d) => keptTitles.has(d.title));
  return { statuses, newCases: ranked, alignment: { status, findings }, diagnostics };
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await worker(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * SPEC v3 §2.2 — judges the cases of a spec against a pull request.
 *
 * A failed run rejects with a QtgError whose `usage` is everything billed up to that point.
 */
export async function verifyCases(
  req: VerifyRequest,
  provider: LlmProvider,
  options: { maxCostUsd: number; expectedOutputTokens: number },
  signal: AbortSignal,
): Promise<VerifyResult & { diagnostics: VerifyDiagnostics }> {
  const llm = asStructured(provider);
  const requirements = requirementsOf(req.spec);
  const warnings: Warning[] = [...(req.pre.warnings ?? [])];
  const changedPaths = new Set<string>([
    ...req.pre.chunks.flatMap((c) => c.files.map((f) => f.path)),
    ...req.pre.skipped.map((s) => s.path),
  ]);

  // A change with no reviewable code: nothing can be judged, and no call is made.
  if (req.pre.chunks.length === 0) {
    // After a first check the cases keep what they have; only one never judged becomes unknown.
    const none = resolveScope(req.newCaseScope ?? null, []);
    const selection = selectCasesToJudge(
      req.cases.filter((c) => c.lifecycle === 'active'),
      none,
      changedPaths,
    );
    const empty = combineVerify(
      [],
      req.cases,
      requirements,
      changedPaths,
      req.maxNewCases,
      none,
      selection.judge,
    );
    empty.diagnostics.rejudge.reasons = none ? selection.reasons : null;
    return { ...empty, usage: ZERO_USAGE, costUsd: 0, calls: 0, warnings };
  }

  const plan = planVerifyRun(req, provider, options);
  if (plan.estimateUsd > options.maxCostUsd) {
    throw new QtgError(
      'cost_cap',
      `The estimated cost of judging even the highest-priority files (~$${plan.estimateUsd.toFixed(2)}) exceeds max-cost-usd ($${options.maxCostUsd.toFixed(2)}), so nothing was judged. Raise max-cost-usd, or lower token-budget so the change is split into smaller parts.`,
    );
  }

  const system = [VERIFY_SYSTEM, planLanguageBlock(req.language)];
  const phase = req.pre.chunks.length > 1 ? 'map' : 'single';
  // The whole sheet, judged now or not: what a new case has to be new against.
  const sheet = req.cases.filter((c) => c.lifecycle === 'active');
  // After the first check: what a new case has to come from and what a status may change for.
  // Files of chunks that are not judged are not shown, so nothing can come from them.
  const { scope } = plan;
  const judged = plan.batches.flat();
  const keptIds = new Set(plan.kept.map((c) => c.caseId));
  const skipped: SkippedFile[] = [
    ...req.pre.skipped,
    ...plan.dropped.flatMap((c) => c.files.map((f) => ({ path: f.path, reason: 'cost_cap' as const }))),
  ];
  const queue: Call[] = plan.chunks.flatMap((chunk) =>
    plan.batches.map((batch, batchIndex) => ({ chunk, batch, batchIndex, withCodeCases: batchIndex === 0 })),
  );

  let usage: LlmUsage = ZERO_USAGE;
  let calls = 0;
  const spent = (): number => provider.estimateCostUsd(usage);
  const outputs: VerifyOutput[] = [];
  const unjudged = new Set<CodeChunk>();
  let failure: unknown;

  await pool(queue, MAP_CONCURRENCY, async (call) => {
    if (failure) return;
    if (calls > 0 && spent() >= options.maxCostUsd) {
      unjudged.add(call.chunk);
      return;
    }
    try {
      calls++;
      const result = await llm.generateStructured<VerifyOutput>(
        {
          system,
          prefix: buildVerifyPrefix(req, requirements, call.batch, scope !== null),
          tail: buildVerifyTail(call.chunk, skipped, {
            phase,
            withCodeCases: call.withCodeCases,
            maxNewCases: req.maxNewCases,
            caseCount: call.batch.length,
            sheet,
            scope,
            keptIds,
          }),
          schema: VerifyOutputSchema,
          sharePrefix: queue.length > 1,
          what: 'code status',
          subject: 'change',
        },
        signal,
      );
      usage = addUsage(usage, result.usage);
      outputs.push(result.value);
    } catch (err) {
      usage = addUsage(usage, usageFromError(err));
      failure ??= err;
    }
  });
  if (failure) throw withBilledUsage(failure, usage);

  const leftOut = [...new Set([...plan.dropped, ...unjudged])];
  if (leftOut.length > 0) {
    const count = leftOut.reduce((n, c) => n + c.files.length, 0);
    warnings.push({
      code: 'cost_cap',
      message: `${count} lower-priority file(s) were not judged because ${unjudged.size > 0 ? 'the run reached' : 'the estimated cost exceeded'} max-cost-usd ($${options.maxCostUsd.toFixed(2)}). Cases that depend on them stay "unknown".`,
    });
  }

  const combined = combineVerify(
    outputs,
    req.cases,
    requirements,
    changedPaths,
    req.maxNewCases,
    scope,
    judged,
  );
  combined.diagnostics.rejudge.reasons = plan.rejudgeReasons;
  for (const d of combined.diagnostics.unknownSameAs) {
    warnings.push({
      code: 'other',
      message: `The new case "${d.title}" was said to repeat ${d.sameAsCaseId}, which is not an active case of this spec. It was kept as a new case.`,
    });
  }
  const costUsd = spent();
  if (costUsd > options.maxCostUsd && leftOut.length === 0) {
    warnings.push({
      code: 'cost_cap',
      message: `The run cost about $${costUsd.toFixed(2)}, above max-cost-usd ($${options.maxCostUsd.toFixed(2)}).`,
    });
  }
  return { ...combined, usage, costUsd, calls, warnings };
}
