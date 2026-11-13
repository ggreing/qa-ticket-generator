/** single / map-reduce orchestration + cost guard (LLM-07/10). Owner: qa-work-session-c(fable). */
import type {
  CodeChunk,
  LlmProvider,
  LlmResult,
  LlmUsage,
  OrchestrateOptions,
  OrchestrateResult,
  PreprocessOutput,
  PromptContext,
  QaReport,
  SkippedFile,
  Warning,
} from '../core/contracts';
import { QtgError } from '../core/errors';
import { languageInstruction, SYSTEM_PROMPT } from './prompts/system';
import { buildMetadataSection, buildPrdSection } from './prompts/user';
import { addUsage, usageFromError, withBilledUsage, ZERO_USAGE } from './usage';

/** Same conservative estimate the preprocessor uses (PRE-08). */
const CHARS_PER_TOKEN = 3.2;
/** Assumed size of one partial report when it is fed to the reduce call. */
const PARTIAL_REPORT_TOKENS = 6_000;
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 } as const;

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const filesOf = (chunks: CodeChunk[]): SkippedFile[] =>
  chunks.flatMap((chunk) => chunk.files.map((file) => ({ path: file.path, reason: 'cost_cap' as const })));

export interface NormalizeOptions {
  /** Every path that is part of the PR (analyzed and skipped). */
  changedPaths: ReadonlySet<string>;
  maxScenarios: number;
  hasPrd: boolean;
}

const cleanPath = (path: string): string => path.trim().replace(/^\.?\/+/, '');

/**
 * Code-side validation of a model report (SPEC §7):
 * - file references that are not part of the PR are removed (one `invalid_related_file` warning);
 * - scenarios are sorted P0 → P2, cut to `maxScenarios` and renumbered from TC-01;
 * - without a PRD the alignment is forced to `no_prd` with no findings;
 * - with findings, the overall status is recomputed from them (the §8 rubric), so `fail-on`
 *   never depends on the model's arithmetic.
 */
export function normalizeReport(
  report: QaReport,
  options: NormalizeOptions,
): { report: QaReport; warnings: Warning[] } {
  const warnings: Warning[] = [];
  let removed = 0;
  const keepKnown = (paths: string[]): string[] => {
    const kept = [...new Set(paths.map(cleanPath))].filter((p) => options.changedPaths.has(p));
    removed += paths.length - kept.length;
    return kept;
  };

  const scenarios = report.scenarios
    .map((scenario, index) => ({ scenario, index }))
    .sort(
      (a, b) =>
        PRIORITY_ORDER[a.scenario.priority] - PRIORITY_ORDER[b.scenario.priority] || a.index - b.index,
    )
    .slice(0, Math.max(0, options.maxScenarios))
    .map(({ scenario }, i) => ({
      ...scenario,
      id: `TC-${String(i + 1).padStart(2, '0')}`,
      relatedFiles: keepKnown(scenario.relatedFiles),
    }));

  // The schema also allows "partial", which only the verify phase defines. Here a requirement
  // that is partly built stays "missing", as the report prompt states it (M3.5).
  let findings = report.prdAlignment.findings.map((f) => ({
    ...f,
    status: f.status === 'partial' ? ('missing' as const) : f.status,
    files: keepKnown(f.files),
  }));
  let status = report.prdAlignment.status;
  if (!options.hasPrd) {
    status = 'no_prd';
    findings = [];
  } else if (findings.length > 0) {
    status = findings.some((f) => f.status === 'contradicts')
      ? 'misaligned'
      : findings.every((f) => f.status === 'covered')
        ? 'aligned'
        : 'partial';
  } else if (status === 'no_prd') {
    status = 'partial'; // a PRD is linked, so "no PRD" would be wrong; nothing could be judged.
  }
  if (options.hasPrd && status !== report.prdAlignment.status) {
    warnings.push({
      code: 'other',
      message: `PRD alignment was reported as "${report.prdAlignment.status}" and corrected to "${status}" to match the findings.`,
    });
  }

  const risks = report.risks.map((risk) => ({ ...risk, files: keepKnown(risk.files) }));
  if (removed > 0) {
    warnings.push({
      code: 'invalid_related_file',
      message: `Removed ${removed} file reference(s) that are not part of this pull request.`,
    });
  }
  return { report: { ...report, prdAlignment: { status, findings }, scenarios, risks }, warnings };
}

export interface RunPlan {
  /** Chunks that will be sent, highest priority first. */
  planned: CodeChunk[];
  /** Lowest-priority chunks left out to fit `maxCostUsd`. */
  dropped: CodeChunk[];
  /** Estimated cost of the planned calls; above `maxCostUsd` only when one chunk alone is. */
  estimateUsd: number;
}

/**
 * LLM-10 — the pre-call cost plan: estimates every map call and the reduce call from token
 * estimates and `expectedOutputTokens`, and drops chunks from the lowest priority upward while
 * the total exceeds `maxCostUsd`. Pure; the eval runner uses it to quote a run's cost.
 */
export function planRun(
  chunks: CodeChunk[],
  provider: Pick<LlmProvider, 'estimateCostUsd'>,
  context: PromptContext,
  options: Pick<OrchestrateOptions, 'maxCostUsd' | 'expectedOutputTokens'>,
): RunPlan {
  const sharedTokens = estimateTokens(
    SYSTEM_PROMPT +
      languageInstruction(context.language) +
      buildPrdSection(context) +
      buildMetadataSection(context),
  );
  const callCost = (inputTokens: number): number =>
    provider.estimateCostUsd({
      inputTokens,
      outputTokens: options.expectedOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  const estimateRun = (list: CodeChunk[]): number => {
    const maps = list.reduce((sum, c) => sum + callCost(sharedTokens + c.estimatedTokens), 0);
    const reduce = list.length > 1 ? callCost(sharedTokens + list.length * PARTIAL_REPORT_TOKENS) : 0;
    return maps + reduce;
  };

  let planned = chunks;
  while (planned.length > 1 && estimateRun(planned) > options.maxCostUsd) planned = planned.slice(0, -1);
  return { planned, dropped: chunks.slice(planned.length), estimateUsd: estimateRun(planned) };
}

/**
 * LLM-07/10 — runs the review: one call in `single` mode, or one call per chunk (bounded
 * concurrency) followed by a merge call in `map_reduce` mode.
 *
 * Cost guard: the run's cost is estimated up front from token estimates and
 * `expectedOutputTokens`; while it exceeds `maxCostUsd`, the lowest-priority chunk is dropped and
 * its files are reported as `cost_cap`. When the top chunk alone is still over the cap, no call
 * is made and the run fails with a `cost_cap` error. During the map phase, once the actual spend
 * reaches the cap no further calls start and the partial reports are merged as is.
 * A truncated reply (`llm_truncated`) is retried once with half the scenario cap (LLM-04).
 *
 * A failed run rejects with a QtgError whose `usage` is everything billed up to that point.
 */
export async function orchestrate(
  pre: PreprocessOutput,
  provider: LlmProvider,
  context: PromptContext,
  options: OrchestrateOptions,
  signal: AbortSignal,
): Promise<OrchestrateResult> {
  if (pre.chunks.length === 0) throw new QtgError('internal', 'orchestrate was called without any chunk.');
  if (signal.aborted) throw new QtgError('cancelled', 'The run was cancelled.');

  const warnings: Warning[] = [];
  let usage: LlmUsage = ZERO_USAGE;
  let costUsd = 0;
  let calls = 0;
  const record = (u: LlmUsage): void => {
    usage = addUsage(usage, u);
    costUsd += provider.estimateCostUsd(u);
    calls += 1;
  };

  // ── LLM-10: pre-call estimate ───────────────────────────────────────────────
  const { planned, dropped, estimateUsd: estimate } = planRun(pre.chunks, provider, context, options);
  if (estimate > options.maxCostUsd) {
    // The cap is a hard limit (SPEC G4): nothing is sent to the model.
    throw new QtgError(
      'cost_cap',
      `The estimated cost of analyzing even the highest-priority files (~$${estimate.toFixed(2)}) exceeds max-cost-usd ($${options.maxCostUsd.toFixed(2)}), so nothing was analyzed. Raise max-cost-usd, or lower token-budget so the change is split into smaller parts.`,
    );
  }

  // ── calls ───────────────────────────────────────────────────────────────────
  const inner = new AbortController();
  const onAbort = (): void => inner.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });

  /** LLM-04 — one retry with half the scenario cap when the reply was cut off. */
  const withTruncationRetry = async (
    call: (ctx: PromptContext) => Promise<LlmResult<QaReport>>,
  ): Promise<QaReport> => {
    try {
      const result = await call(context);
      record(result.usage);
      return result.value;
    } catch (err) {
      if (!(err instanceof QtgError)) throw err;
      record(usageFromError(err));
      if (err.code !== 'llm_truncated') throw err;
    }
    const reduced = { ...context, maxScenarios: Math.max(1, Math.floor(context.maxScenarios / 2)) };
    try {
      const result = await call(reduced);
      record(result.usage);
      return result.value;
    } catch (err) {
      if (err instanceof QtgError) record(usageFromError(err));
      throw err;
    }
  };

  const allSkipped = (extra: CodeChunk[]): SkippedFile[] => [...pre.skipped, ...filesOf(extra)];
  const unstarted: CodeChunk[] = [];
  let report: QaReport;

  try {
    if (planned.length === 1) {
      const chunk = planned[0] as CodeChunk;
      report = await withTruncationRetry((ctx) =>
        provider.generateReport(
          { context: ctx, chunk, skipped: allSkipped(dropped), phase: 'single' },
          inner.signal,
        ),
      );
    } else {
      const partials: (QaReport | undefined)[] = new Array(planned.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (!inner.signal.aborted) {
          const index = next;
          if (index >= planned.length) return;
          // LLM-10: stop starting calls once the actual spend has reached the cap.
          if (index > 0 && costUsd >= options.maxCostUsd) return;
          next += 1;
          const chunk = planned[index] as CodeChunk;
          const others = planned.filter((_, i) => i !== index);
          partials[index] = await withTruncationRetry((ctx) =>
            provider.generateReport(
              { context: ctx, chunk, skipped: allSkipped([...others, ...dropped]), phase: 'map' },
              inner.signal,
            ),
          );
        }
      };
      const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, planned.length)) }, () =>
        worker().catch((err) => {
          inner.abort(err);
          throw err;
        }),
      );
      const settled = await Promise.allSettled(workers);
      const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (failed) throw failed.reason;

      unstarted.push(...planned.slice(next));
      const done = partials.filter((p): p is QaReport => p !== undefined);
      report =
        done.length === 1
          ? (done[0] as QaReport)
          : await withTruncationRetry((ctx) =>
              provider.mergeReports({ context: ctx, partials: done }, inner.signal),
            );
    }
  } catch (err) {
    const cancelled = signal.aborted && !(err instanceof QtgError && err.code === 'cancelled');
    const failure = cancelled ? new QtgError('cancelled', 'The run was cancelled.', { cause: err }) : err;
    throw withBilledUsage(failure, usage); // total billed so far, across every call of this run
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  // ── bookkeeping ─────────────────────────────────────────────────────────────
  const capped = [...unstarted, ...dropped];
  const skipped = filesOf(capped);
  if (skipped.length > 0) {
    const why =
      unstarted.length > 0
        ? `the run reached max-cost-usd ($${options.maxCostUsd.toFixed(2)})`
        : `the estimated cost exceeded max-cost-usd ($${options.maxCostUsd.toFixed(2)})`;
    warnings.push({
      code: 'cost_cap',
      message: `${skipped.length} lower-priority file(s) were not analyzed because ${why}.`,
    });
  } else if (costUsd > options.maxCostUsd) {
    warnings.push({
      code: 'cost_cap',
      message: `The run cost about $${costUsd.toFixed(2)}, above max-cost-usd ($${options.maxCostUsd.toFixed(2)}).`,
    });
  }

  const changedPaths = new Set<string>();
  for (const chunk of pre.chunks) {
    for (const file of chunk.files) {
      changedPaths.add(file.path);
      if (file.previousPath) changedPaths.add(file.previousPath);
    }
  }
  for (const file of pre.skipped) changedPaths.add(file.path);

  const normalized = normalizeReport(report, {
    changedPaths,
    maxScenarios: context.maxScenarios,
    hasPrd: context.prdDocuments.length > 0,
  });
  warnings.push(...normalized.warnings);

  return { report: normalized.report, usage, costUsd, calls, skipped, warnings };
}
