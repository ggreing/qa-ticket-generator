/**
 * Slack notices for the v3 phases (SPEC v3 §2.2 verify, §5 plan). The messages come from
 * ./slack-v3-blocks; this module only sends them.
 *
 * - Verify, bot mode: one message per pull request. A re-run edits it with `chat.update`; its
 *   channel and timestamp travel in the PR comment's hidden state (`statePatch`), as in v2. Thread
 *   replies left by an earlier v2 report on the same PR are removed, since the card above them now
 *   tells a different story. If the old message is gone, a new one is posted.
 * - Plan: a new message per run (a spec has no PR comment to keep state in). A run that skipped
 *   generation (`spec_unchanged`) sends nothing.
 * - Webhook mode: a new message every time; webhooks cannot edit.
 *
 * Nothing here throws: a failure is logged without content and returned as a `slack_failed`
 * warning, so Slack can never break a run.
 * Owner: qa-work-session-b.
 */

import type { CaseSetSummary } from '../core/cases';
import type { QtgConfig } from '../core/config';
import type { DeliveryState, Logger, Warning } from '../core/contracts';
import type { SlackMessage } from './render/slack-blocks';
import type { VerifySummaryInput } from './render/verify-summary';
import {
  createSlackClient,
  describeError,
  previousMessage,
  REQUEST_TIMEOUT_MS,
  type SlackChatClient,
  type SlackState,
} from './slack';
import { buildPlanNotice, buildVerifyNotice, type PlanChanges } from './slack-v3-blocks';

export interface SlackNoticeResult {
  ok: boolean;
  /** To merge into the PR comment's DeliveryState (verify, bot mode). */
  statePatch?: Pick<DeliveryState, 'slack'>;
  warning?: Warning;
}

export interface PlanNoticeContext {
  /** Spec-side overview a sink published (`SinkOutcome.summaryUrl` of the primary sink). */
  listUrl?: string;
  /** What the primary sink changed in this run. */
  changes?: PlanChanges;
  /** `PlanOutcome.skipped`: nothing was generated, so nothing is announced. */
  skipped?: 'spec_unchanged';
}

export interface SlackNotifier {
  postVerify(data: VerifySummaryInput, state: DeliveryState): Promise<SlackNoticeResult>;
  postPlan(summary: CaseSetSummary, ctx?: PlanNoticeContext): Promise<SlackNoticeResult>;
}

export interface SlackNotifierDeps {
  /** Bot mode client; defaults to a `WebClient` built from the bot token. */
  client?: SlackChatClient;
  /** Webhook mode transport; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const failed = (statePatch?: Pick<DeliveryState, 'slack'>): SlackNoticeResult => ({
  ok: false,
  ...(statePatch ? { statePatch } : {}),
  warning: { code: 'slack_failed', message: 'Slack notification failed; see the workflow log.' },
});

/** The v3 Slack notifier for the configured mode, or `null` when Slack is off. */
export function createSlackNotifier(
  slack: QtgConfig['slack'],
  logger: Logger,
  deps: SlackNotifierDeps = {},
): SlackNotifier | null {
  if (slack.mode === 'off') return null;

  if (slack.mode === 'webhook') {
    const post = deps.fetch ?? fetch;
    const send = async (what: string, build: () => SlackMessage): Promise<SlackNoticeResult> => {
      try {
        const message = build();
        const res = await post(slack.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: message.text, blocks: message.blocks }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          logger.warn(`Slack webhook responded with HTTP ${res.status}.`);
          return failed();
        }
        logger.info(`Slack: ${what} notice sent through the webhook.`);
        return { ok: true };
      } catch (err) {
        logger.warn(`Slack webhook request failed (${describeError(err)}).`);
        return failed();
      }
    };
    return {
      postVerify: (data) => send('verify', () => buildVerifyNotice(data)),
      async postPlan(summary, ctx = {}) {
        if (ctx.skipped) return { ok: true };
        return send('plan', () => buildPlanNotice(summary, ctx));
      },
    };
  }

  const client = deps.client ?? createSlackClient(slack.token);
  const postMessage = async (message: SlackMessage): Promise<{ channel: string; ts: string }> => {
    const res = await client.chat.postMessage({
      channel: slack.channel,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!res.ts || !res.channel) throw new Error('Slack returned no message timestamp.');
    return { channel: res.channel, ts: res.ts };
  };

  return {
    async postVerify(data, state) {
      const previous: SlackState | undefined = previousMessage(slack.channel, state);
      let parent: { channel: string; ts: string } | undefined;
      try {
        const message = buildVerifyNotice(data);
        let updated = false;
        if (previous) {
          try {
            await client.chat.update({
              channel: previous.channel,
              ts: previous.ts,
              text: message.text,
              blocks: message.blocks,
            });
            parent = { channel: previous.channel, ts: previous.ts };
            updated = true;
          } catch (err) {
            // The old message is gone (deleted, archived channel…): post a fresh one instead.
            logger.warn(`Slack update failed (${describeError(err)}); posting a new message.`);
          }
        }
        parent ??= await postMessage(message);

        // A v2 report on this PR may have left ticket replies under the message.
        const remaining: string[] = [];
        for (const ts of previous?.replies ?? []) {
          try {
            await client.chat.delete({ channel: previous?.channel ?? parent.channel, ts });
          } catch (err) {
            if (describeError(err) !== 'message_not_found') remaining.push(ts);
          }
        }
        logger.info(`Slack: verify notice ${updated ? 'updated' : 'posted'}.`);
        return { ok: true, statePatch: { slack: { ...parent, replies: updated ? remaining : [] } } };
      } catch (err) {
        logger.warn(`Slack verify notice failed (${describeError(err)}).`);
        // Keep what exists so the next run can update it.
        return failed(parent ? { slack: { ...parent, replies: previous?.replies ?? [] } } : undefined);
      }
    },

    async postPlan(summary, ctx = {}) {
      if (ctx.skipped) return { ok: true };
      try {
        await postMessage(buildPlanNotice(summary, ctx));
        logger.info('Slack: plan notice posted.');
        return { ok: true };
      } catch (err) {
        logger.warn(`Slack plan notice failed (${describeError(err)}).`);
        return failed();
      }
    },
  };
}
