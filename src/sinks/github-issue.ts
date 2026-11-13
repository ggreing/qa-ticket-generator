/** github-issue case sink (SPEC v3 §5). Owner: qa-work-session-a. */
import type { CaseSink, SinkContext } from '../core/cases';
import type { Octokit } from '../core/octokit';
import { notImplemented } from '../core/stub';

export function createGitHubIssueCaseSink(
  _octokit: Octokit,
  _options: { owner: string; repo: string },
  _ctx: SinkContext,
): CaseSink {
  return notImplemented('sinks/github-issue');
}
