/** Marker PR comment + hidden qtg-state storage (DLV-01/02/03). Owner: qa-work-session-c(fable). */
import { isAbortError, isRateLimitError, type RetryOptions, statusOf, withRetry } from '../context/retry';
import type { Logger, PrCommentStore, PullRequestInfo, Warning } from '../core/contracts';
import type { Octokit } from '../core/octokit';
import { MAX_COMMENT_CHARS } from './render/markdown';
import { parseState, REPORT_MARKER, serializeState } from './state';

/** Author of comments written with the workflow's built-in `GITHUB_TOKEN`. */
export const ACTIONS_BOT_LOGIN = 'github-actions[bot]';

export interface PrCommentStoreDeps {
  /** Backoff tuning for GitHub calls (tests inject an instant `sleep`). */
  retry?: RetryOptions;
  /**
   * Login whose marker comments are trusted, overriding the lookup. Needed for tokens that are
   * neither a user token nor the Actions token, e.g. a custom GitHub App (`my-app[bot]`).
   */
  trustedAuthor?: string;
  logger?: Pick<Logger, 'debug'>;
}

/** Joins marker, body and state; trims the body if a caller hands over more than GitHub accepts. */
export function composeComment(body: string, stateBlock: string): string {
  const overhead = REPORT_MARKER.length + stateBlock.length + 3;
  const room = MAX_COMMENT_CHARS - overhead;
  const safeBody = body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body;
  return `${REPORT_MARKER}\n${safeBody}\n\n${stateBlock}`;
}

/**
 * DLV-01/02 — stores the report in a single PR comment identified by a hidden marker.
 * `load` finds that comment and reads the state block; `save` edits it in place and creates it
 * only when absent.
 *
 * Only marker comments written by the token's own identity are trusted, because anyone who can
 * comment on the PR could otherwise plant a marker comment with forged state. The identity is
 * `GET /user` when the token can call it (user tokens), `github-actions[bot]` when it cannot
 * (the Actions token), or `deps.trustedAuthor`. It is looked up once per store. With several
 * trusted marker comments, the most recent one is used.
 *
 * Every GitHub call is retried on 5xx and rate limits with backoff (the shared Octokit has no
 * retry plugin). Creating is not idempotent, so a retried create first looks for a comment the
 * failed attempt may have left behind and edits that one instead of adding a second.
 */
export function createPrCommentStore(octokit: Octokit, deps: PrCommentStoreDeps = {}): PrCommentStore {
  const target = (pr: PullRequestInfo) => ({ owner: pr.owner, repo: pr.repo });
  const call = <T>(fn: () => Promise<T>): Promise<T> => withRetry(fn, deps.retry);

  let identity: Promise<string> | undefined;
  const resolveIdentity = async (): Promise<string> => {
    const override = deps.trustedAuthor?.trim();
    if (override) return override;
    try {
      const { data } = await call(() => octokit.rest.users.getAuthenticated());
      return data.login;
    } catch (err) {
      // Installation tokens (including GITHUB_TOKEN) may not call GET /user: 403 or 404.
      const status = statusOf(err);
      const denied = (status === 403 || status === 404) && !isAbortError(err) && !isRateLimitError(err);
      if (denied) return ACTIONS_BOT_LOGIN;
      throw err;
    }
  };
  const trustedAuthor = (): Promise<string> => {
    identity ??= resolveIdentity().catch((err: unknown) => {
      identity = undefined; // do not cache a transient failure
      throw err;
    });
    return identity;
  };

  const findMarkerComment = async (pr: PullRequestInfo) => {
    const author = (await trustedAuthor()).toLowerCase();
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      ...target(pr),
      issue_number: pr.number,
      per_page: 100,
    });
    const marked = comments.filter((c) => (c.body ?? '').trimStart().startsWith(REPORT_MARKER));
    const trusted = marked.filter((c) => c.user?.login?.toLowerCase() === author);
    if (trusted.length < marked.length) {
      deps.logger?.debug(
        `Ignored ${marked.length - trusted.length} report-marker comment(s) written by other authors.`,
      );
    }
    // Most recent first: by creation time, then by id.
    return trusted.reduce<(typeof trusted)[number] | undefined>((latest, c) => {
      if (!latest) return c;
      const newer = c.created_at === latest.created_at ? c.id > latest.id : c.created_at > latest.created_at;
      return newer ? c : latest;
    }, undefined);
  };

  const update = async (pr: PullRequestInfo, commentId: number, body: string) => {
    const { data } = await octokit.rest.issues.updateComment({ ...target(pr), comment_id: commentId, body });
    return { commentId: data.id, url: data.html_url };
  };

  return {
    async load(pr) {
      const existing = await call(() => findMarkerComment(pr));
      if (!existing) return { commentId: null, state: { v: 1 }, warnings: [] };

      const { state, corrupted } = parseState(existing.body ?? '');
      const warnings: Warning[] = corrupted
        ? [
            {
              code: 'state_corrupted',
              message:
                'The hidden state in the report comment was missing or invalid, so this run started fresh (an earlier Slack message may not be updated).',
            },
          ]
        : [];
      return { commentId: existing.id, state, warnings };
    },

    async save(pr, commentId, body, state) {
      const full = composeComment(body, serializeState(state));
      if (commentId !== null) {
        try {
          return await call(() => update(pr, commentId, full));
        } catch (err) {
          // Only a plain 404 means "deleted since load"; create a new comment below.
          if (statusOf(err) !== 404) throw err;
        }
      }
      let attempts = 0;
      return call(async () => {
        attempts += 1;
        if (attempts > 1) {
          const leftover = await findMarkerComment(pr);
          if (leftover) return update(pr, leftover.id, full);
        }
        const { data } = await octokit.rest.issues.createComment({
          ...target(pr),
          issue_number: pr.number,
          body: full,
        });
        return { commentId: data.id, url: data.html_url };
      });
    },
  };
}
