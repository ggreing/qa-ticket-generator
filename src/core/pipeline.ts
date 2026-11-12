/**
 * Pipeline orchestration (SPEC §6.2). Pure wiring over injected dependencies so it can be
 * tested end-to-end with fakes. OWNERSHIP: control session only.
 *
 * The input adapter (src/adapters/*) is responsible for: reading inputs, building the
 * TriggerEvent, calling the trigger gate, fetching the PR, loading the repo config and
 * constructing these deps. `runPipeline` starts once a run has been decided.
 */
import type { QtgConfig } from './config';
import type {
  Deliverer,
  DeliveryState,
  ExtractPrdRefs,
  FinalReport,
  GitHubReader,
  IsNoisePath,
  LlmProvider,
  LlmUsage,
  Logger,
  OrchestrateOptions,
  OrchestrateResult,
  PrCommentStore,
  PrdCollection,
  PrdProvider,
  PrdRef,
  PreprocessEngine,
  PreprocessOutput,
  PromptContext,
  PullRequestInfo,
  RunMeta,
  TriggerEvent,
  Warning,
} from './contracts';
import { QtgError, toQtgError } from './errors';

export interface PipelineDeps {
  logger: Logger;
  github: GitHubReader;
  commentStore: PrCommentStore;
  prdProviders: PrdProvider[];
  extractPrdRefs: ExtractPrdRefs;
  collectPrdDocuments: (
    refs: PrdRef[],
    providers: PrdProvider[],
    options: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<PrdCollection>;
  preprocessEngine: PreprocessEngine;
  isNoisePath: IsNoisePath;
  llm: LlmProvider;
  orchestrate: (
    pre: PreprocessOutput,
    provider: LlmProvider,
    context: PromptContext,
    options: OrchestrateOptions,
    signal: AbortSignal,
  ) => Promise<OrchestrateResult>;
  renderPrComment: (final: FinalReport) => string;
  /** Optional channels; summary (Job Summary / CLI stdout) is always present. */
  summary: Deliverer;
  slack: Deliverer | null;
  now: () => number;
}

export interface PipelineOutcome {
  final: FinalReport;
  /** True when the check should fail (fail-on / fail-on-error / require-prd). */
  failed: boolean;
}

const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const PRD_TIMEOUT_MS = 15_000;
const EXPECTED_OUTPUT_TOKENS = 32_000;
const MAP_CONCURRENCY = 3;

export async function runPipeline(
  deps: PipelineDeps,
  cfg: QtgConfig,
  pr: PullRequestInfo,
  event: TriggerEvent,
  signal: AbortSignal,
): Promise<PipelineOutcome> {
  const { logger } = deps;
  const started = deps.now();
  const warnings: Warning[] = [];
  const meta: RunMeta = {
    model: cfg.model,
    effort: cfg.effort,
    mode: 'none',
    sha: pr.headSha,
    usage: ZERO_USAGE,
    costUsd: 0,
    durationMs: 0,
    calls: 0,
    skipped: [],
    redactions: [],
    prdSources: [],
    warnings,
    dryRun: cfg.dryRun,
  };
  const base = { pr, meta, language: cfg.language } as const;

  let commentId: number | null = null;
  let state: DeliveryState = { v: 1 };
  let final: FinalReport;

  try {
    if (!cfg.dryRun && cfg.prComment) {
      const loaded = await deps.commentStore.load(pr);
      commentId = loaded.commentId;
      state = loaded.state;
      warnings.push(...loaded.warnings);
    }

    // TRG-04 — skip pushes that only touched noise files since the last analyzed SHA.
    if (event.action === 'synchronize' && state.sha && state.sha !== pr.headSha) {
      const paths = await deps.github.listPathsChangedBetween(pr, state.sha, pr.headSha);
      if (paths.length > 0 && paths.every((p) => deps.isNoisePath(p, cfg.preprocess))) {
        logger.info(`Only noise files changed since ${state.sha.slice(0, 7)}; skipping.`);
        final = { ...base, status: 'skipped', report: null, skipReason: 'no_logic_change' };
        await deliverSummaryOnly(deps, final, state);
        return { final, failed: false };
      }
    }

    const files = await logger.group('Fetch PR files', () => deps.github.listChangedFiles(pr));

    const refs = deps.extractPrdRefs(pr.body, {
      defaultOwner: pr.owner,
      defaultRepo: pr.repo,
      jiraProjectKeys: cfg.jiraProjectKeys,
      maxDocuments: cfg.maxPrdDocuments,
    });
    meta.prdSources = refs;
    const prd = await logger.group('Fetch PRD documents', () =>
      deps.collectPrdDocuments(refs, deps.prdProviders, { timeoutMs: PRD_TIMEOUT_MS, signal }),
    );
    warnings.push(...prd.warnings);
    if (refs.length === 0)
      warnings.push({ code: 'prd_not_linked', message: 'No PRD linked in the PR body.' });
    if (cfg.requirePrd && prd.documents.length === 0) {
      throw new QtgError(
        'prd_required',
        'require-prd is enabled but no linked PRD document could be fetched.',
      );
    }

    const pre = await logger.group('Preprocess', async () =>
      deps.preprocessEngine.run({ files, prdDocuments: prd.documents, options: cfg.preprocess }),
    );
    meta.mode = pre.mode;
    meta.skipped = pre.skipped;
    meta.redactions = pre.redactions;

    if (pre.chunks.length === 0) {
      final = { ...base, status: 'skipped', report: null, skipReason: 'no_files' };
    } else {
      const context: PromptContext = {
        pr: {
          number: pr.number,
          title: pr.title,
          body: pr.body,
          htmlUrl: pr.htmlUrl,
          author: pr.author,
          baseRef: pr.baseRef,
          headRef: pr.headRef,
        },
        prdDocuments: pre.prdDocuments,
        language: cfg.language,
        maxScenarios: cfg.maxScenarios,
        repoInstructions: cfg.repoInstructions,
      };
      const result = await logger.group('Generate QA report', () =>
        deps.orchestrate(
          pre,
          deps.llm,
          context,
          {
            maxCostUsd: cfg.maxCostUsd,
            concurrency: MAP_CONCURRENCY,
            expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
          },
          signal,
        ),
      );
      meta.usage = result.usage;
      meta.costUsd = result.costUsd;
      meta.calls = result.calls;
      meta.skipped = [...pre.skipped, ...result.skipped];
      warnings.push(...result.warnings);
      final = { ...base, status: 'ok', report: result.report };
    }
  } catch (err) {
    const e = toQtgError(err);
    logger.error(`${e.code}: ${e.message}`);
    final = { ...base, status: 'error', report: null, error: { code: e.code, message: e.userMessage } };
    if (e.code === 'cancelled') {
      meta.durationMs = deps.now() - started;
      return { final, failed: false }; // concurrency cancel: publish nothing (SPEC §10)
    }
  }

  meta.durationMs = deps.now() - started;
  if (final.status === 'ok') state = { ...state, sha: pr.headSha };
  await deliverAll(deps, cfg, final, state, commentId);

  return { final, failed: shouldFail(cfg, final) };
}

function shouldFail(cfg: QtgConfig, final: FinalReport): boolean {
  if (final.status === 'error') return cfg.failOnError || final.error?.code === 'prd_required';
  if (final.status !== 'ok' || !final.report) return false;
  const status = final.report.prdAlignment.status;
  if (cfg.failOn === 'misaligned') return status === 'misaligned';
  if (cfg.failOn === 'partial') return status === 'misaligned' || status === 'partial';
  return false;
}

async function deliverSummaryOnly(
  deps: PipelineDeps,
  final: FinalReport,
  state: DeliveryState,
): Promise<void> {
  const res = await deps.summary.deliver(final, state);
  if (res.warning) final.meta.warnings.push(res.warning);
}

/** DLV-08 — channels are independent; Slack runs before the PR comment so its ts lands in the saved state. */
async function deliverAll(
  deps: PipelineDeps,
  cfg: QtgConfig,
  final: FinalReport,
  state: DeliveryState,
  commentId: number | null,
): Promise<void> {
  let next = state;
  // 'no_files' is still worth telling the PR about ("no logic changes to analyze", SPEC §10).
  const publishable = final.status !== 'skipped' || final.skipReason === 'no_files';
  if (!cfg.dryRun && deps.slack && publishable) {
    try {
      const res = await deps.slack.deliver(final, next);
      if (res.statePatch) next = { ...next, ...res.statePatch };
      if (res.warning) final.meta.warnings.push(res.warning);
    } catch (err) {
      deps.logger.warn(`Slack delivery failed: ${(err as Error).message}`);
      final.meta.warnings.push({
        code: 'slack_failed',
        message: 'Slack delivery failed; see the workflow log.',
      });
    }
  }
  if (!cfg.dryRun && cfg.prComment && publishable) {
    try {
      await deps.commentStore.save(final.pr, commentId, deps.renderPrComment(final), next);
    } catch (err) {
      deps.logger.warn(`PR comment failed: ${(err as Error).message}`);
      final.meta.warnings.push({ code: 'comment_failed', message: 'Could not write the PR comment.' });
    }
  }
  await deliverSummaryOnly(deps, final, next);
}
