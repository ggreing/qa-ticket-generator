/** GitHub reads (SPEC §5.2, CTX-01..05). Owner: qa-work-session-a. */
import type { GitHubReader } from '../core/contracts';
import type { Octokit } from '../core/octokit';
import { notImplemented } from '../core/stub';

export interface GitHubReaderOptions {
  owner: string;
  repo: string;
  /** File extensions whose head content should be fetched for AST expansion (CTX-03). */
  astExtensions: string[];
  /** Max bytes per fetched file (default 1MB). */
  maxContentBytes?: number;
}

export function createGitHubReader(_octokit: Octokit, _options: GitHubReaderOptions): GitHubReader {
  return notImplemented('context/createGitHubReader');
}
