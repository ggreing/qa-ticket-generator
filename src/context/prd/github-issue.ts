/** GitHub Issue PRD provider (PRD-06/10). Owner: qa-work-session-a. */
import type { PrdDocument, PrdProvider } from '../../core/contracts';
import type { Octokit } from '../../core/octokit';
import { isAbortError, isRateLimitError, type RetryOptions, statusOf, withRetry } from '../retry';
import { extractAcceptanceCriteria } from './ac';
import { PrdFetchError } from './errors';

/** Test seams. */
export interface GitHubIssueDeps {
  retry?: RetryOptions;
}

const ISSUE_ID = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

function toFetchError(err: unknown, id: string): unknown {
  const status = statusOf(err);
  if (status === undefined || isAbortError(err)) return err;
  if ((status === 403 || status === 404) && !isRateLimitError(err)) {
    // PRD-10 — the default GITHUB_TOKEN only sees the current repository.
    return new PrdFetchError(
      'permission',
      `Cannot read ${id} (HTTP ${status}): the token has no access. Issues in other private repositories need a PAT or GitHub App token in github-token.`,
      { status },
    );
  }
  if (status === 410) return new PrdFetchError('not_found', `${id} was deleted (HTTP 410).`, { status });
  return new PrdFetchError('http', `GitHub request for ${id} failed (HTTP ${status}).`, { status });
}

/**
 * PRD-06 — GitHub Issue provider: title, body and labels via `issues.get`, for the current
 * repository or any other the token can read. 403/404 become a `permission` failure (PRD-10).
 *
 * @param octokit The run's Octokit client.
 * @param deps Optional retry overrides for tests.
 */
export function createGitHubIssueProvider(octokit: Octokit, deps: GitHubIssueDeps = {}): PrdProvider {
  return {
    source: 'github',
    isConfigured: () => true,
    async fetch(ref, signal): Promise<PrdDocument> {
      const m = ref.id.match(ISSUE_ID);
      if (!m?.[1] || !m[2] || !m[3]) {
        throw new PrdFetchError(
          'invalid_ref',
          'The reference is not a valid GitHub issue (owner/repo#number).',
        );
      }
      const [, owner, repo, num] = m;
      let data: Awaited<ReturnType<Octokit['rest']['issues']['get']>>['data'];
      try {
        ({ data } = await withRetry(
          () => octokit.rest.issues.get({ owner, repo, issue_number: Number(num), request: { signal } }),
          { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, ...deps.retry },
          signal,
        ));
      } catch (err) {
        throw toFetchError(err, ref.id);
      }

      const body = data.body ?? '';
      const labels = data.labels
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter((l) => l !== '');
      return {
        ref,
        title: data.title,
        bodyMarkdown: body,
        acceptanceCriteria: extractAcceptanceCriteria(body),
        url: data.html_url,
        meta: {
          repository: `${owner}/${repo}`,
          number: String(data.number),
          state: data.state,
          kind: data.pull_request ? 'pull_request' : 'issue',
          ...(labels.length ? { labels: labels.join(', ') } : {}),
        },
      };
    },
  };
}
