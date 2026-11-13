/**
 * Verify phase (SPEC v3 §2.2): a PR is checked against the QA cases of the spec it links.
 * Each case gets a code status, code-only risks become new cases, the tickets are updated and
 * the PR gets one summary comment. Pure wiring over injected modules. OWNERSHIP: control session.
 *
 * A PR that links no spec returns `{ kind: 'no_spec' }` so the adapter can fall back to the
 * v2 risk comment (runPipeline).
 */
import type {
  ApplyVerify,
  CaseSink,
  ExistingCaseTicket,
  QaCase,
  RenderedCase,
  VerifyRequest,
  VerifyResult,
} from './cases';
import type { QtgConfig } from './config';
import type {
  DeliveryState,
  ExtractPrdRefs,
  GitHubReader,
  IsNoisePath,
  Language,
  LlmProvider,
  LlmUsage,
  Logger,
  PrCommentStore,
  PrdCollection,
  PrdProvider,
  PrdRef,
  PreprocessEngine,
  PullRequestInfo,
  RedactText,
  TriggerEvent,
  Warning,
} from './contracts';
import { toQtgError } from './errors';
import { EXPECTED_OUTPUT_TOKENS, PRD_TIMEOUT_MS } from './limits';
import { type PlanDeps, type PlanOutcome, primarySink, type SinkOutcome, syncSink } from './plan-pipeline';
import type { QaReport } from './schema';

/** What the verify summary renderer needs (mirrors src/delivery VerifySummaryInput). */
export interface VerifySummaryData {
  pr: Pick<PullRequestInfo, 'number' | 'title' | 'htmlUrl' | 'owner' | 'repo'>;
  spec: { ref: PrdRef; title: string };
  language: Language;
  sha: string;
  alignment: QaReport['prdAlignment'];
  cases: (QaCase & { url?: string })[];
  newCaseIds: string[];
  maxChecklist: number;
  meta: {
    model: string;
    usage: LlmUsage;
    costUsd: number;
    durationMs: number;
    calls: number;
    warnings: Warning[];
    dryRun?: boolean;
  };
}

export interface VerifyDeps {
  logger: Logger;
  github: GitHubReader;
  commentStore: PrCommentStore;
  prdProviders: PrdProvider[];
  extractPrdRefs: ExtractPrdRefs;
  collectPrdDocuments: PlanDeps['collectPrdDocuments'];
  preprocessEngine: PreprocessEngine;
  isNoisePath: IsNoisePath;
  redactText: RedactText;
  llm: LlmProvider;
  verifyCases: (
    req: VerifyRequest,
    provider: LlmProvider,
    options: { maxCostUsd: number; expectedOutputTokens: number },
    signal: AbortSignal,
  ) => Promise<VerifyResult>;
  applyVerify: ApplyVerify;
  planSync: PlanDeps['planSync'];
  renderCase: PlanDeps['renderCase'];
  sinks: CaseSink[];
  /** §2.2 — no cases yet for this spec: run the plan phase first. */
  runPlan: (spec: PrdRef, signal: AbortSignal) => Promise<PlanOutcome>;
  renderComment: (data: VerifySummaryData) => string;
  renderSummary: (data: VerifySummaryData) => string;
  writeSummary: (markdown: string) => Promise<void>;
  now: () => number;
}

export type VerifyOutcome =
  | { kind: 'no_spec' }
  | { kind: 'skipped'; reason: 'no_logic_change' }
  | {
      kind: 'verified';
      status: 'ok' | 'error';
      spec: PrdRef;
      cases: QaCase[];
      newCaseIds: string[];
      sinks: SinkOutcome[];
      alignment: QaReport['prdAlignment'] | null;
      costUsd: number;
      warnings: Warning[];
      error?: { code: string; message: string };
      /** True when the check should fail (fail-on / fail-on-error). */
      failed: boolean;
    };

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export async function runVerify(
  deps: VerifyDeps,
  cfg: QtgConfig,
  pr: PullRequestInfo,
  event: TriggerEvent,
  signal: AbortSignal,
): Promise<VerifyOutcome> {
  const { logger } = deps;
  const started = deps.now();

  // A spec is what makes this a v3 run; without one the adapter falls back to v2.
  const refs = deps.extractPrdRefs(pr.body, {
    defaultOwner: pr.owner,
    defaultRepo: pr.repo,
    jiraProjectKeys: cfg.jiraProjectKeys,
    maxDocuments: cfg.maxPrdDocuments,
  });
  if (refs.length === 0) return { kind: 'no_spec' };

  const warnings: Warning[] = [];
  const safePr: PullRequestInfo = {
    ...pr,
    title: deps.redactText(pr.title).text,
    body: deps.redactText(pr.body).text,
  };
  const sinks = cfg.dryRun ? deps.sinks.filter((s) => s.kind === 'file') : deps.sinks;
  const configured = sinks.filter((s) => s.isConfigured());

  let commentId: number | null = null;
  let state: DeliveryState = { v: 1 };
  if (!cfg.dryRun && cfg.prComment) {
    const loaded = await deps.commentStore.load(pr);
    commentId = loaded.commentId;
    state = loaded.state;
    warnings.push(...loaded.warnings);
  }

  // TRG-04 — pushes that touched only noise files since the last analyzed SHA.
  if (event.action === 'synchronize' && state.sha && state.sha !== pr.headSha) {
    const paths = await deps.github.listPathsChangedBetween(pr, state.sha, pr.headSha);
    if (paths.length > 0 && paths.every((p) => deps.isNoisePath(p, cfg.preprocess))) {
      logger.info(`Only noise files changed since ${state.sha.slice(0, 7)}; skipping.`);
      return { kind: 'skipped', reason: 'no_logic_change' };
    }
  }

  const specRef = refs[0] as PrdRef;
  const out: Extract<VerifyOutcome, { kind: 'verified' }> = {
    kind: 'verified',
    status: 'ok',
    spec: specRef,
    cases: [],
    newCaseIds: [],
    sinks: [],
    alignment: null,
    costUsd: 0,
    warnings,
    failed: false,
  };
  let specTitle = specRef.raw;
  let usage = ZERO;
  let calls = 0;

  try {
    const prd: PrdCollection = await logger.group('Fetch spec', () =>
      deps.collectPrdDocuments(refs, deps.prdProviders, { timeoutMs: PRD_TIMEOUT_MS, signal }),
    );
    warnings.push(...prd.warnings);
    const spec = prd.documents.find((d) => d.ref.id === specRef.id) ?? prd.documents[0];
    if (!spec) return { kind: 'no_spec' };
    out.spec = spec.ref;
    specTitle = deps.redactText(spec.title).text;

    // Existing cases from the primary sink; none yet → plan first (§2.2).
    const primary = primarySink(configured);
    let existing: ExistingCaseTicket[] = primary
      ? await logger.group(`Read cases (${primary.kind})`, () => primary.list(spec.ref, signal))
      : [];
    let cases = existing.map((t) => t.lastWritten).filter((c): c is QaCase => c !== null);
    if (cases.length === 0) {
      logger.info('No QA cases for this spec yet; running the plan phase first.');
      const plan = await deps.runPlan(spec.ref, signal);
      out.costUsd += plan.costUsd;
      warnings.push(...plan.warnings);
      if (plan.status === 'error') {
        throw Object.assign(new Error(plan.error?.message ?? 'plan failed'), {
          code: plan.error?.code,
        });
      }
      cases = plan.cases;
      existing = primary ? await primary.list(spec.ref, signal) : [];
    }

    const files = await logger.group('Fetch PR files', () => deps.github.listChangedFiles(pr));
    const pre = await logger.group('Preprocess', async () =>
      deps.preprocessEngine.run({ files, prdDocuments: prd.documents, options: cfg.preprocess }),
    );
    if (pre.warnings) warnings.push(...pre.warnings);

    const active = cases.filter((c) => c.lifecycle === 'active');
    const result = await logger.group('Check cases against the code', () =>
      deps.verifyCases(
        {
          spec: { ...spec, title: specTitle },
          cases: active,
          pre,
          pr: {
            number: pr.number,
            title: safePr.title,
            body: safePr.body,
            htmlUrl: pr.htmlUrl,
            author: pr.author,
            baseRef: pr.baseRef,
            headRef: pr.headRef,
          },
          sha: pr.headSha,
          language: cfg.language,
          maxNewCases: Math.max(0, cfg.maxCases - active.length),
        },
        deps.llm,
        {
          maxCostUsd: Math.max(0, cfg.maxCostUsd - out.costUsd),
          expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
        },
        signal,
      ),
    );
    usage = result.usage;
    calls = result.calls;
    out.costUsd += result.costUsd;
    out.alignment = result.alignment;
    warnings.push(...result.warnings);

    const before = new Set(cases.map((c) => c.caseId));
    const merged = deps.applyVerify(cases, result, pr.headSha, spec.ref.id);
    warnings.push(...merged.warnings);
    out.cases = merged.cases;
    out.newCaseIds = merged.cases.filter((c) => !before.has(c.caseId)).map((c) => c.caseId);

    const render = (c: QaCase): RenderedCase => deps.renderCase(c, cfg.language);
    const urls = new Map<string, string>();
    for (const sink of configured) {
      out.sinks.push(
        await syncSink(
          sink,
          sink === primary ? existing : null,
          out.cases,
          render,
          spec.ref,
          urls,
          deps,
          signal,
        ),
      );
    }

    const data: VerifySummaryData = {
      pr: { number: pr.number, title: safePr.title, htmlUrl: pr.htmlUrl, owner: pr.owner, repo: pr.repo },
      spec: { ref: spec.ref, title: specTitle },
      language: cfg.language,
      sha: pr.headSha,
      alignment: result.alignment,
      cases: out.cases.map((c) => ({ ...c, url: urls.get(c.caseId) })),
      newCaseIds: out.newCaseIds,
      maxChecklist: cfg.maxScenarios,
      meta: {
        model: deps.llm.id,
        usage,
        costUsd: out.costUsd,
        durationMs: deps.now() - started,
        calls,
        warnings,
        dryRun: cfg.dryRun,
      },
    };
    if (!cfg.dryRun && cfg.prComment) {
      try {
        await deps.commentStore.save(pr, commentId, deps.renderComment(data), { ...state, sha: pr.headSha });
      } catch (err) {
        logger.warn(`PR comment failed: ${(err as Error).message}`);
        warnings.push({ code: 'comment_failed', message: 'Could not write the PR comment.' });
      }
    }
    await deps.writeSummary(deps.renderSummary(data));

    const status = result.alignment.status;
    out.failed =
      (cfg.failOn === 'misaligned' && status === 'misaligned') ||
      (cfg.failOn === 'partial' && (status === 'misaligned' || status === 'partial'));
  } catch (err) {
    const e = toQtgError(err);
    logger.error(`${e.code}: ${e.message}`);
    out.status = 'error';
    out.error = { code: e.code, message: e.userMessage };
    if (e.usage) out.costUsd += deps.llm.estimateCostUsd(e.usage);
    out.failed = cfg.failOnError;
    await deps.writeSummary(`### 🧪 QA cases — check failed\n\n${e.code}: ${e.userMessage}\n`);
  }
  return out;
}
