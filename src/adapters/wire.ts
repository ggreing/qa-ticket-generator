/**
 * Shared composition root for the Action and the CLI: validates inputs, gates the trigger,
 * loads the PR and repo config, builds every module and runs the pipeline.
 * OWNERSHIP: control session.
 */

import { existsSync } from 'node:fs';
import { applyVerify, lintCaseStyle, planSync, reconcileCases, renderCase } from '../cases';
import { createGitHubReader } from '../context/github';
import { createGitHubIssueProvider } from '../context/prd/github-issue';
import { createJiraProvider } from '../context/prd/jira';
import { createNotionProvider } from '../context/prd/notion';
import { extractPrdRefs } from '../context/prd/refs';
import { collectPrdDocuments } from '../context/prd/registry';
import type { CaseSink } from '../core/cases';
import { type InputReader, parseRepoConfig, type QtgConfig, resolveConfig } from '../core/config';
import type { FinalReport, Logger, PrdRef, TriggerEvent, TriggerSkipReason } from '../core/contracts';
import { QtgError } from '../core/errors';
import { astExtensionsFor } from '../core/languages';
import { MAX_OUTPUT_TOKENS } from '../core/limits';
import type { Octokit } from '../core/octokit';
import { type PipelineOutcome, runPipeline } from '../core/pipeline';
import { type PlanDeps, type PlanOutcome, runPlan } from '../core/plan-pipeline';
import { runVerify, type VerifyOutcome } from '../core/verify-pipeline';
import { createPrCommentStore } from '../delivery/comment-store';
import { renderPrComment } from '../delivery/render/markdown';
import { renderVerifyComment, renderVerifySummaryMarkdown } from '../delivery/render/verify-summary';
import { createSlackDeliverer } from '../delivery/slack';
import { createSummaryDeliverer, type SummarySink } from '../delivery/summary';
import { createAnthropicProvider } from '../llm/anthropic';
import { orchestrate } from '../llm/orchestrate';
import { generatePlan } from '../llm/plan';
import { verifyCases } from '../llm/verify';
import { createPreprocessEngine, isNoisePath } from '../preprocess';
import { finalizeRedactions, redactText as redactRaw } from '../preprocess/redact';
import { createFileCaseSink, FILE_NAMES } from '../sinks/file';
import { createGitHubIssueCaseSink } from '../sinks/github-issue';
import { createJiraCaseSink } from '../sinks/jira';
import { createNotionCaseSink } from '../sinks/notion';
import { decideTrigger } from '../trigger/gate';
import { prNumberOf } from './event';
import { decideMode } from './mode';

export interface ExecuteRequest {
  input: InputReader;
  event: TriggerEvent;
  owner: string;
  repo: string;
  octokit: Octokit;
  logger: Logger;
  sink: SummarySink;
  /** Target of Slack's `[View full report]` button. */
  fullReportUrl: (final: FinalReport) => string | undefined;
  signal: AbortSignal;
  /** The CLI is an explicit request: bypass the label gate. */
  bypassGate?: boolean;
  /** SPEC v3 §5 — where the file sink writes qa-cases.{md,csv,json}. */
  caseFileDir: string;
  /**
   * SPEC v3 §5 — `qa-cases.json` to continue from when the `previous-cases` input is empty, used only
   * if the file exists. The CLI passes `<out-dir>/qa-cases.json` so a re-run in the same folder keeps ids.
   */
  defaultPreviousCases?: string;
}

export type ExecuteResult =
  | { kind: 'skipped'; reason: TriggerSkipReason }
  | { kind: 'ran'; outcome: PipelineOutcome; config: QtgConfig }
  | { kind: 'planned'; outcome: PlanOutcome; config: QtgConfig }
  | { kind: 'verified'; outcome: Extract<VerifyOutcome, { kind: 'verified' }>; config: QtgConfig };

const SKIP_TEXT: Record<TriggerSkipReason, string> = {
  irrelevant_label: 'A different label was added.',
  label_absent: 'The trigger label is not on this PR.',
  rerun_disabled: 'rerun-on-push is disabled.',
  closed: 'The PR is closed.',
  fork_pr:
    'Fork PRs are skipped by default because secrets are not available to them. See docs/examples/workflow-fork-opt-in.yml to opt in.',
  unsupported_event: 'This event does not trigger a QA run.',
  no_logic_change: 'Only non-logic files changed since the last analysis.',
  already_checked:
    'This commit was already checked against the QA cases. Run the workflow by hand to check it again.',
};

export async function execute(req: ExecuteRequest): Promise<ExecuteResult> {
  const { input, event, logger } = req;
  // Validate inputs early (repo config is merged after the PR is known).
  const early = resolveConfig(input, parseRepoConfig(null));

  // SPEC v3 §2 — plan (spec -> cases) or verify (PR).
  const mode = decideMode(event, {
    mode: early.mode,
    spec: early.spec,
    planLabel: early.planLabel,
    owner: req.owner,
    repo: req.repo,
    jiraProjectKeys: early.jiraProjectKeys,
  });
  if (mode.mode === 'skip') {
    logger.info(`Skipping: ${mode.reason}`);
    await req.sink.writeMarkdown(
      `### 🧪 QA cases — skipped\n\n${SKIP_TEXT[mode.reason]} (\`${mode.reason}\`)\n`,
    );
    return { kind: 'skipped', reason: mode.reason };
  }
  if (mode.mode === 'plan') return executePlan(req, early, mode.spec);

  if (!req.bypassGate) {
    const decision = decideTrigger(event, {
      triggerLabel: early.triggerLabel,
      rerunOnPush: early.rerunOnPush,
      allowForkPrs: early.allowForkPrs,
    });
    if (!decision.run) {
      const reason = decision.reason ?? 'unsupported_event';
      logger.info(`Skipping: ${reason}`);
      await req.sink.writeMarkdown(
        `### 🧪 AI QA Scenarios — skipped\n\n${SKIP_TEXT[reason]} (\`${reason}\`)\n`,
      );
      return { kind: 'skipped', reason };
    }
  }

  const prNumber = prNumberOf(event);
  if (!prNumber) {
    await req.sink.writeMarkdown('### 🧪 AI QA Scenarios — skipped\n\nNo pull request number.\n');
    return { kind: 'skipped', reason: 'unsupported_event' };
  }

  const reader = createGitHubReader(req.octokit, {
    owner: req.owner,
    repo: req.repo,
    astExtensions: astExtensionsFor(early.preprocess.astLanguages),
    logger,
  });
  const pr = await reader.getPullRequest(prNumber);
  const cfg = resolveConfig(input, parseRepoConfig(await reader.getRepoConfigText(pr, early.configPath)));

  const preprocessEngine = await createPreprocessEngine({ astLanguages: cfg.preprocess.astLanguages });
  const llm = buildLlm(cfg, logger);
  const prdProviders = buildPrdProviders(req, cfg);
  const commentStore = createPrCommentStore(req.octokit, {
    logger,
    ...(cfg.commentAuthor ? { trustedAuthor: cfg.commentAuthor } : {}),
  });

  // SPEC v3 §2.2 — a PR that links a spec is checked against that spec's QA cases.
  const sinks = buildSinks(req, cfg);
  const verified = await runVerify(
    {
      logger,
      github: reader,
      commentStore,
      prdProviders,
      extractPrdRefs,
      collectPrdDocuments,
      preprocessEngine,
      isNoisePath,
      redactText,
      llm,
      verifyCases,
      applyVerify,
      planSync,
      renderCase,
      sinks,
      runPlan: (spec, signal) => runPlan(planDeps(req, cfg, llm, sinks), cfg, spec, signal),
      renderComment: renderVerifyComment,
      renderSummary: renderVerifySummaryMarkdown,
      writeSummary: (markdown) => req.sink.writeMarkdown(markdown),
      now: () => Date.now(),
    },
    cfg,
    pr,
    event,
    req.signal,
  );
  if (verified.kind === 'verified') return { kind: 'verified', outcome: verified, config: cfg };
  if (verified.kind === 'skipped') {
    await req.sink.writeMarkdown(
      `### 🧪 QA cases — skipped\n\n${SKIP_TEXT[verified.reason]} (\`${verified.reason}\`)\n`,
    );
    return { kind: 'skipped', reason: verified.reason };
  }

  // No spec linked: the v2 risk comment.
  const outcome = await runPipeline(
    {
      logger,
      github: reader,
      commentStore,
      prdProviders,
      extractPrdRefs,
      collectPrdDocuments,
      preprocessEngine,
      isNoisePath,
      redactText,
      llm,
      orchestrate,
      renderPrComment,
      summary: createSummaryDeliverer(req.sink),
      slack: createSlackDeliverer(cfg.slack, logger, { fullReportUrl: req.fullReportUrl }),
      now: () => Date.now(),
    },
    cfg,
    pr,
    event,
    req.signal,
  );
  return { kind: 'ran', outcome, config: cfg };
}

function buildLlm(cfg: QtgConfig, logger: Logger) {
  return createAnthropicProvider(
    {
      apiKey: cfg.anthropicApiKey,
      model: cfg.model,
      effort: cfg.effort,
      serverFallback: cfg.serverFallback,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    { logger },
  );
}

function buildPrdProviders(req: ExecuteRequest, cfg: QtgConfig) {
  return [
    createGitHubIssueProvider(req.octokit),
    createJiraProvider(cfg.jira),
    createNotionProvider(cfg.notionToken),
  ];
}

/** SPEC v3 §5 — the previous `qa-cases.json` for the file sink: the input, else an existing default. */
export function previousCasesFor(
  req: Pick<ExecuteRequest, 'defaultPreviousCases' | 'logger'>,
  cfg: QtgConfig,
): string | null {
  if (cfg.previousCases) return cfg.previousCases;
  const fallback = req.defaultPreviousCases;
  if (fallback && existsSync(fallback)) {
    req.logger.info(`Continuing from the earlier ${FILE_NAMES.json} in the output folder.`);
    return fallback;
  }
  return null;
}

/** SPEC v3 §5 — the configured case sinks. Dry-run keeps only the file sink. */
function buildSinks(req: ExecuteRequest, cfg: QtgConfig): CaseSink[] {
  const { logger } = req;
  const ctx = { logger, language: cfg.language };
  const kinds = cfg.dryRun ? (['file'] as const) : cfg.sinks;
  if (cfg.dryRun && cfg.sinks.some((k) => k !== 'file')) {
    logger.info(
      'Dry-run: writing qa-cases files only. Pass --publish (CLI) or dry-run: false to create tickets.',
    );
  }
  return kinds.map((kind) => {
    switch (kind) {
      case 'jira':
        return createJiraCaseSink(cfg.jira ? { ...cfg.jira, subtaskType: cfg.jiraSubtaskType } : null, ctx);
      case 'github-issue':
        return createGitHubIssueCaseSink(
          req.octokit,
          {
            owner: req.owner,
            repo: req.repo,
            ...(cfg.commentAuthor ? { trustedAuthor: cfg.commentAuthor } : {}),
          },
          ctx,
        );
      case 'notion':
        return createNotionCaseSink(
          cfg.notionToken && cfg.notionQaDatabaseId
            ? { token: cfg.notionToken, databaseId: cfg.notionQaDatabaseId }
            : null,
          ctx,
        );
      case 'file':
        return createFileCaseSink({ dir: req.caseFileDir, previous: previousCasesFor(req, cfg) }, ctx);
      default:
        throw new QtgError('config_invalid', `Unknown sink "${String(kind)}".`);
    }
  });
}

function planDeps(
  req: ExecuteRequest,
  cfg: QtgConfig,
  llm: ReturnType<typeof buildLlm>,
  sinks: CaseSink[],
): PlanDeps {
  return {
    logger: req.logger,
    prdProviders: buildPrdProviders(req, cfg),
    collectPrdDocuments,
    redactText,
    llm,
    generatePlan,
    reconcileCases,
    planSync,
    renderCase,
    lintCaseStyle,
    sinks,
  };
}

async function executePlan(req: ExecuteRequest, early: QtgConfig, spec: PrdRef): Promise<ExecuteResult> {
  const { input, logger } = req;
  // Repo config from the default branch: a plan run has no PR base to read it from.
  const { data: repoInfo } = await req.octokit.rest.repos.get({ owner: req.owner, repo: req.repo });
  const reader = createGitHubReader(req.octokit, {
    owner: req.owner,
    repo: req.repo,
    astExtensions: [],
    logger,
  });
  const repoText = await reader.getFileContent(
    `${req.owner}/${req.repo}`,
    early.configPath,
    repoInfo.default_branch,
  );
  const cfg = resolveConfig(input, parseRepoConfig(repoText));
  const llm = buildLlm(cfg, logger);
  const outcome = await runPlan(planDeps(req, cfg, llm, buildSinks(req, cfg)), cfg, spec, req.signal);
  await req.sink.writeMarkdown(renderPlanSummary(outcome));
  return { kind: 'planned', outcome, config: cfg };
}

/** Job Summary / CLI stdout for a plan run. */
export function renderPlanSummary(o: PlanOutcome): string {
  if (o.status === 'error') {
    return `### 🧪 QA cases — failed\n\n${o.error?.code}: ${o.error?.message}\n`;
  }
  const active = o.cases.filter((c) => c.lifecycle === 'active');
  const count = (p: string) => active.filter((c) => c.priority === p).length;
  const lines = [
    `### 🧪 QA cases for ${o.spec.raw}`,
    '',
    `${active.length} cases (P0 ${count('P0')} · P1 ${count('P1')} · P2 ${count('P2')}), ` +
      `${o.cases.length - active.length} no longer apply. Cost $${o.costUsd.toFixed(2)}.`,
    '',
    '| Sink | Created | Updated | Suggested | Marked obsolete | Unchanged | Status |',
    '|---|---|---|---|---|---|---|',
    ...o.sinks.map(
      (s) =>
        `| ${s.kind} | ${s.created} | ${s.updated} | ${s.suggested} | ${s.obsoleted} | ${s.unchanged} | ${s.ok ? 'ok' : (s.error ?? 'failed')} |`,
    ),
  ];
  if (o.styleViolations > 0) {
    lines.push('', `Style check: ${o.styleViolations} phrases read as machine-written.`);
  }
  return `${lines.join('\n')}\n`;
}

/** PRE-05 for the PR title/body, using the engine's own marker pipeline (spoof-proof counts). */
export function redactText(text: string): { text: string; redactions: { type: string; count: number }[] } {
  const counts = new Map<string, number>();
  const out = finalizeRedactions(redactRaw(text), counts);
  return { text: out, redactions: [...counts].map(([type, count]) => ({ type, count })) };
}

/** Collects the secrets present in the inputs so adapters can mask them in logs. */
export function secretInputs(input: InputReader): string[] {
  return [
    'anthropic-api-key',
    'github-token',
    'slack-bot-token',
    'slack-webhook-url',
    'jira-api-token',
    'notion-token',
  ]
    .map((name) => input(name).trim())
    .filter((v) => v.length > 0);
}
