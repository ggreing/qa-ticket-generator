/** Slack Bot (post/update/thread) + Webhook fallback (DLV-04/05/06). Owner: qa-work-session-c(fable). */
import { type KnownBlock, WebClient } from '@slack/web-api';
import type { QtgConfig } from '../core/config';
import type { Deliverer, DeliveryResult, DeliveryState, FinalReport, Logger } from '../core/contracts';
import { buildSummaryCard, buildThreadMessages, type SlackMessage } from './render/slack-blocks';

interface ChatMessageArgs {
  channel: string;
  text: string;
  blocks: KnownBlock[];
  thread_ts?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

/** The three Web API methods this module calls; lets tests inject a fake client. */
export interface SlackChatClient {
  chat: {
    postMessage(args: ChatMessageArgs): Promise<{ ok?: boolean; channel?: string; ts?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks: KnownBlock[] }): Promise<unknown>;
    delete(args: { channel: string; ts: string }): Promise<unknown>;
  };
}

export interface SlackDelivererDeps {
  /** Bot mode client; defaults to a `WebClient` built from the bot token. */
  client?: SlackChatClient;
  /** Webhook mode transport; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Target of the `[View full report]` button; defaults to the PR page, where the report comment lives. */
  fullReportUrl?: (final: FinalReport) => string | undefined;
}

type SlackState = NonNullable<DeliveryState['slack']>;

const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

/** Short, content-free description of a failure for the log (never a URL, token or message body). */
function describeError(err: unknown): string {
  const e = err as { data?: { error?: string }; code?: string; name?: string } | null;
  return e?.data?.error ?? e?.code ?? e?.name ?? 'unknown error';
}

const failed = (statePatch?: Partial<DeliveryState>): DeliveryResult => ({
  channel: 'slack',
  ok: false,
  statePatch,
  warning: { code: 'slack_failed', message: 'Slack delivery failed; see the workflow log.' },
});

/**
 * Builds the Slack channel for the configured mode, or `null` when Slack is off.
 *
 * Bot mode (DLV-04): the summary card is the parent message and scenario details go in its
 * thread. On a re-run the parent is edited with `chat.update`, the previous replies are removed
 * with `chat.delete` and the details are posted again; the message timestamps travel in the PR
 * comment's hidden state via `statePatch`. A failed or skipped run only refreshes an existing
 * parent and never starts a new message.
 *
 * Webhook mode (DLV-05): each run posts one new summary card; webhooks cannot edit or thread.
 *
 * The returned deliverer does not throw: failures come back as `ok: false` with a warning, along
 * with whatever state is needed to clean up on the next run (DLV-08).
 */
export function createSlackDeliverer(
  slack: QtgConfig['slack'],
  logger: Logger,
  deps: SlackDelivererDeps = {},
): Deliverer | null {
  if (slack.mode === 'off') return null;
  const reportUrl = (final: FinalReport): string => deps.fullReportUrl?.(final) ?? final.pr.htmlUrl;

  if (slack.mode === 'webhook') {
    const post = deps.fetch ?? fetch;
    return {
      channel: 'slack',
      async deliver(final) {
        const card = buildSummaryCard(final, reportUrl(final));
        try {
          const res = await post(slack.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: card.text, blocks: card.blocks }),
          });
          if (!res.ok) {
            logger.warn(`Slack webhook responded with HTTP ${res.status}.`);
            return failed();
          }
          logger.info('Slack: summary card sent through the webhook.');
          return { channel: 'slack', ok: true };
        } catch (err) {
          logger.warn(`Slack webhook request failed (${describeError(err)}).`);
          return failed();
        }
      },
    };
  }

  const client: SlackChatClient = deps.client ?? new WebClient(slack.token);
  const postMessage = async (channel: string, message: SlackMessage, threadTs?: string) => {
    const res = await client.chat.postMessage({
      channel,
      text: message.text,
      blocks: message.blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!res.ts || !res.channel) throw new Error('Slack returned no message timestamp.');
    return { channel: res.channel, ts: res.ts };
  };

  return {
    channel: 'slack',
    async deliver(final, state) {
      // State written for another channel is ignored, so a config change starts a new message.
      const sameChannel =
        !state.slack || !CHANNEL_ID.test(slack.channel) || state.slack.channel === slack.channel;
      const previous: SlackState | undefined = sameChannel ? state.slack : undefined;
      const card = buildSummaryCard(final, reportUrl(final));

      if (final.status !== 'ok') {
        if (!previous) return { channel: 'slack', ok: true };
        try {
          await client.chat.update({
            channel: previous.channel,
            ts: previous.ts,
            text: card.text,
            blocks: card.blocks,
          });
          logger.info('Slack: parent message updated with the run status.');
          return { channel: 'slack', ok: true };
        } catch (err) {
          logger.warn(`Slack update failed (${describeError(err)}).`);
          return failed();
        }
      }

      let parent: { channel: string; ts: string } | undefined;
      let updated = false;
      const replies: string[] = [];
      let staleReplies: string[] = previous?.replies ?? [];
      try {
        if (previous) {
          try {
            await client.chat.update({
              channel: previous.channel,
              ts: previous.ts,
              text: card.text,
              blocks: card.blocks,
            });
            parent = { channel: previous.channel, ts: previous.ts };
            updated = true;
          } catch (err) {
            // The old parent is gone (deleted, archived channel…): post a fresh one instead.
            logger.warn(`Slack update failed (${describeError(err)}); posting a new message.`);
          }
        }
        parent ??= await postMessage(slack.channel, card);

        let removed = 0;
        const remaining: string[] = [];
        for (const ts of staleReplies) {
          try {
            await client.chat.delete({ channel: previous?.channel ?? parent.channel, ts });
            removed += 1;
          } catch (err) {
            if (describeError(err) !== 'message_not_found') remaining.push(ts);
          }
        }
        staleReplies = updated ? remaining : [];

        for (const message of buildThreadMessages(final)) {
          replies.push((await postMessage(parent.channel, message, parent.ts)).ts);
        }
        logger.info(
          `Slack: parent ${updated ? 'updated' : 'posted'}, ${replies.length} thread message(s) posted, ${removed} old one(s) removed.`,
        );
        return {
          channel: 'slack',
          ok: true,
          statePatch: { slack: { ...parent, replies: [...staleReplies, ...replies] } },
        };
      } catch (err) {
        logger.warn(`Slack delivery failed (${describeError(err)}).`);
        // Keep what exists so the next run can update and clean it up.
        return failed(parent ? { slack: { ...parent, replies: [...staleReplies, ...replies] } } : undefined);
      }
    },
  };
}
