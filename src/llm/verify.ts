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
import { buildCaseIndex, buildVerifyPrefix, buildVerifyTail, VERIFY_SYSTEM } from './prompts/verify';
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
  /** Active cases, split into batches of at most MAX_CASES_PER_CALL. */
  batches: QaCase[][];
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
  const batches: QaCase[][] = [];
  for (let i = 0; i < active.length; i += MAX_CASES_PER_CALL)
    batches.push(active.slice(i, i + MAX_CASES_PER_CALL));
  if (batches.length === 0) batches.push([]);

  const requirements = requirementsOf(req.spec);
  const system = estimateTokens(VERIFY_SYSTEM + planLanguageBlock(req.language));
  const prefixTokens = batches.map((batch) =>
    estimateTokens(buildVerifyPrefix(req, requirements, batch).join('\n')),
  );
  // The call that may write new cases also gets the index of the whole sheet.
  const indexTokens = estimateTokens(buildCaseIndex(active));
  const cost = (inputTokens: number, outputTokens: number): number =>
    provider.estimateCostUsd({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const estimate = (chunks: CodeChunk[]): number =>
    chunks.reduce(
      (sum, chunk) =>
        sum +
        batches.reduce(
          (s, batch, b) =>
            s +
            cost(
              system + (prefixTokens[b] as number) + chunk.estimatedTokens + (b === 0 ? indexTokens : 0),
              expectedOutput(batch.length, b === 0, req.maxNewCases, options.expectedOutputTokens),
            ),
          0,
        ),
      0,
    );

  let chunks = req.pre.chunks;
  while (chunks.length > 1 && estimate(chunks) > options.maxCostUsd) chunks = chunks.slice(0, -1);
  return {
    batches,
    chunks,
    dropped: req.pre.chunks.slice(chunks.length),
    calls: chunks.length * batches.length,
    estimateUsd: estimate(chunks),
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
 */
export function combineVerify(
  outputs: VerifyOutput[],
  cases: QaCase[],
  requirements: Requirement[],
  changedPaths: ReadonlySet<string>,
  maxNewCases: number,
): Pick<VerifyResult, 'statuses' | 'newCases' | 'alignment'> {
  const files = (list: string[]): string[] => [
    ...new Set(list.map((f) => f.trim()).filter((f) => changedPaths.has(f))),
  ];

  // ── statuses: the strongest answer per case ─────────────────────────────────
  const best = new Map<string, VerifyResult['statuses'][number]>();
  const known = new Set(cases.map((c) => c.caseId));
  for (const output of outputs) {
    for (const s of output.statuses) {
      const caseId = s.caseId.trim();
      if (!known.has(caseId)) continue; // a status for a case that is not on the sheet
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
  // Every active case gets a status; one the model skipped is unknown, not silently absent.
  const statuses = cases
    .filter((c) => c.lifecycle === 'active')
    .map(
      (c) => best.get(c.caseId) ?? { caseId: c.caseId, status: 'unknown' as const, evidence: '', files: [] },
    );

  // ── new cases: once each, most important first ──────────────────────────────
  const labels = new Map(requirements.map((r) => [r.label.toUpperCase().replace(/[\s-]/g, ''), r.label]));
  const existingTitles = new Set(cases.map((c) => key(c.title)));
  const seen = new Set<string>();
  const newCases: CaseDraft[] = [];
  for (const output of outputs) {
    for (const raw of output.newCases) {
      const c = toCodeCase(raw, labels);
      if (!c) continue;
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
  return { statuses, newCases: ranked, alignment: { status, findings } };
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
): Promise<VerifyResult> {
  const llm = asStructured(provider);
  const requirements = requirementsOf(req.spec);
  const warnings: Warning[] = [...(req.pre.warnings ?? [])];
  const changedPaths = new Set<string>([
    ...req.pre.chunks.flatMap((c) => c.files.map((f) => f.path)),
    ...req.pre.skipped.map((s) => s.path),
  ]);

  // A change with no reviewable code: nothing can be judged, and no call is made.
  if (req.pre.chunks.length === 0) {
    const empty = combineVerify([], req.cases, requirements, changedPaths, req.maxNewCases);
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
  // The whole sheet, every batch: what a new case has to be new against.
  const sheet = plan.batches.flat();
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
          prefix: buildVerifyPrefix(req, requirements, call.batch),
          tail: buildVerifyTail(call.chunk, skipped, {
            phase,
            withCodeCases: call.withCodeCases,
            maxNewCases: req.maxNewCases,
            caseCount: call.batch.length,
            sheet: sheet,
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

  const combined = combineVerify(outputs, req.cases, requirements, changedPaths, req.maxNewCases);
  const costUsd = spent();
  if (costUsd > options.maxCostUsd && leftOut.length === 0) {
    warnings.push({
      code: 'cost_cap',
      message: `The run cost about $${costUsd.toFixed(2)}, above max-cost-usd ($${options.maxCostUsd.toFixed(2)}).`,
    });
  }
  return { ...combined, usage, costUsd, calls, warnings };
}
