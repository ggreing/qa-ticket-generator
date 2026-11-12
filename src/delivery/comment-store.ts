/** Marker PR comment + hidden qtg-state storage (DLV-01/02/03). Owner: qa-work-session-c(fable). */
import type { PrCommentStore, PullRequestInfo, Warning } from '../core/contracts';
import type { Octokit } from '../core/octokit';
import { MAX_COMMENT_CHARS } from './render/markdown';
import { parseState, REPORT_MARKER, serializeState } from './state';

const isNotFound = (err: unknown): boolean => (err as { status?: number } | null)?.status === 404;

/** Joins marker, body and state; trims the body if a caller hands over more than GitHub accepts. */
export function composeComment(body: string, stateBlock: string): string {
  const overhead = REPORT_MARKER.length + stateBlock.length + 3;
  const room = MAX_COMMENT_CHARS - overhead;
  const safeBody = body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body;
  return `${REPORT_MARKER}\n${safeBody}\n\n${stateBlock}`;
}

/**
 * DLV-01/02 — stores the report in a single PR comment identified by a hidden marker.
 * `load` finds that comment (any author: the token may belong to github-actions[bot], an app or
 * a user) and reads the state block; `save` edits it in place and creates it only when absent.
 */
export function createPrCommentStore(octokit: Octokit): PrCommentStore {
  const target = (pr: PullRequestInfo) => ({ owner: pr.owner, repo: pr.repo });

  return {
    async load(pr) {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        ...target(pr),
        issue_number: pr.number,
        per_page: 100,
      });
      const existing = comments.find((c) => (c.body ?? '').trimStart().startsWith(REPORT_MARKER));
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
          const { data } = await octokit.rest.issues.updateComment({
            ...target(pr),
            comment_id: commentId,
            body: full,
          });
          return { commentId: data.id, url: data.html_url };
        } catch (err) {
          if (!isNotFound(err)) throw err; // deleted since load → create a new one below
        }
      }
      const { data } = await octokit.rest.issues.createComment({
        ...target(pr),
        issue_number: pr.number,
        body: full,
      });
      return { commentId: data.id, url: data.html_url };
    },
  };
}
