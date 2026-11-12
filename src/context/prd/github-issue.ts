/** GitHub Issue PRD provider (PRD-06/10). Owner: qa-work-session-a. */
import type { PrdProvider } from '../../core/contracts';
import type { Octokit } from '../../core/octokit';
import { notImplemented } from '../../core/stub';

export function createGitHubIssueProvider(_octokit: Octokit): PrdProvider {
  return notImplemented('prd/createGitHubIssueProvider');
}
