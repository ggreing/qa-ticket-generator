/**
 * Shared composition root for the Action and the CLI: validates inputs, gates the trigger,
 * loads the PR and repo config, builds every module and runs the pipeline.
 * OWNERSHIP: control session.
 */

import { createGitHubReader } from '../context/github';
import { createGitHubIssueProvider } from '../context/prd/github-issue';
import { createJiraProvider } from '../context/prd/jira';
import { createNotionProvider } from '../context/prd/notion';
import { extractPrdRefs } from '../context/prd/refs';
import { collectPrdDocuments } from '../context/prd/registry';
import { type InputReader, parseRepoConfig, type QtgConfig, resolveConfig } from '../core/config';
import type { FinalReport, Logger, TriggerEvent, TriggerSkipReason } from '../core/contracts';
import { astExtensionsFor } from '../core/languages';
import { MAX_OUTPUT_TOKENS } from '../core/limits';
import type { Octokit } from '../core/octokit';
import { type PipelineOutcome, runPipeline } from '../core/pipeline';
import { createPrCommentStore } from '../delivery/comment-store';
import { renderPrComment } from '../delivery/render/markdown';
import { createSlackDeliverer } from '../delivery/slack';
import { createSummaryDeliverer, type SummarySink } from '../delivery/summary';
import { createAnthropicProvider } from '../llm/anthropic';
import { orchestrate } from '../llm/orchestrate';
import { createPreprocessEngine, isNoisePath } from '../preprocess';
import { finalizeRedactions, redactText as redactRaw } from '../preprocess/redact';
import { decideTrigger } from '../trigger/gate';
import { prNumberOf } from './event';

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
}

export type ExecuteResult =
  | { kind: 'skipped'; reason: TriggerSkipReason }
  | { kind: 'ran'; outcome: PipelineOutcome; config: QtgConfig };

const SKIP_TEXT: Record<TriggerSkipReason, string> = {
  irrelevant_label: 'A different label was added.',
  label_absent: 'The trigger label is not on this PR.',
  rerun_disabled: 'rerun-on-push is disabled.',
  closed: 'The PR is closed.',
  fork_pr:
    'Fork PRs are skipped by default because secrets are not available to them. See docs/examples/workflow-fork-opt-in.yml to opt in.',
  unsupported_event: 'This event does not trigger a QA run.',
  no_logic_change: 'Only non-logic files changed since the last analysis.',
};

export async function execute(req: ExecuteRequest): Promise<ExecuteResult> {
  const { input, event, logger } = req;
  // Validate inputs early (repo config is merged after the PR is known).
  const early = resolveConfig(input, parseRepoConfig(null));

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
  const llm = createAnthropicProvider(
    {
      apiKey: cfg.anthropicApiKey,
      model: cfg.model,
      effort: cfg.effort,
      serverFallback: cfg.serverFallback,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    { logger },
  );

  const outcome = await runPipeline(
    {
      logger,
      github: reader,
      commentStore: createPrCommentStore(req.octokit, {
        logger,
        ...(cfg.commentAuthor ? { trustedAuthor: cfg.commentAuthor } : {}),
      }),
      prdProviders: [
        createGitHubIssueProvider(req.octokit),
        createJiraProvider(cfg.jira),
        createNotionProvider(cfg.notionToken),
      ],
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
