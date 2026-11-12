/** GitHub reads (SPEC §5.2, CTX-01..05). Owner: qa-work-session-a. */
import type { ChangedFile, FileStatus, GitHubReader, Logger } from '../core/contracts';
import { QtgError } from '../core/errors';
import type { Octokit } from '../core/octokit';
import { isAbortError, mapLimit, type RetryOptions, statusOf, withRetry } from './retry';

export interface GitHubReaderOptions {
  owner: string;
  repo: string;
  /** File extensions whose head content should be fetched for AST expansion (CTX-03). */
  astExtensions: string[];
  /** Max bytes per fetched file (default 1MB). */
  maxContentBytes?: number;
  /** Max changed files to list (default and GitHub API ceiling: 3000). */
  maxFiles?: number;
  /** Parallel head-content fetches (default 5). */
  contentConcurrency?: number;
  /** Backoff tuning; tests inject `sleep`. */
  retry?: RetryOptions;
  /** Receives counts and statuses only — never file contents. */
  logger?: Logger;
}

const ONE_MB = 1024 * 1024;
const MAX_FILES = 3000;
const PER_PAGE = 100;
/** The compare API lists at most 300 files; a list this long may be truncated. */
const COMPARE_FILE_CAP = 300;
const FILE_STATUSES: readonly FileStatus[] = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged',
];

/** Lower-cased extension with a leading dot (`src/a.TS` → `.ts`), or '' when none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function normalizeExtension(ext: string): string {
  const e = ext.trim().toLowerCase();
  return e.startsWith('.') ? e : `.${e}`;
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new QtgError('github_api', `Invalid repository name "${fullName}".`);
  }
  return { owner, repo };
}

function toGitHubError(err: unknown, action: string): unknown {
  if (err instanceof QtgError) return err;
  const status = statusOf(err);
  if (status === undefined || isAbortError(err)) return err; // aborts and bugs keep their identity
  return new QtgError('github_api', `GitHub API request failed (HTTP ${status}) while ${action}.`, {
    cause: err,
  });
}

function hasBinaryBytes(buf: Buffer): boolean {
  return buf.subarray(0, 8_000).includes(0);
}

/**
 * Creates the GitHub reader used by the pipeline (CTX-01..05). Every call is wrapped in
 * exponential-backoff retries for 5xx and rate limits, since the @actions/github Octokit
 * ships without the retry/throttling plugins.
 *
 * @param octokit Client from `getOctokit(token)`; tests inject `request.fetch`.
 * @param options Base repository and fetch limits.
 */
export function createGitHubReader(octokit: Octokit, options: GitHubReaderOptions): GitHubReader {
  const { owner, repo, logger } = options;
  const maxBytesDefault = options.maxContentBytes ?? ONE_MB;
  const maxFiles = Math.min(options.maxFiles ?? MAX_FILES, MAX_FILES);
  const concurrency = Math.max(1, options.contentConcurrency ?? 5);
  const astExtensions = new Set(options.astExtensions.map(normalizeExtension));
  const retry: RetryOptions = {
    ...options.retry,
    onRetry: (info) => {
      logger?.debug(
        `GitHub request failed (HTTP ${info.status ?? '?'}); retry ${info.attempt} in ${info.delayMs}ms.`,
      );
      options.retry?.onRetry?.(info);
    },
  };
  const call = <T>(fn: () => Promise<T>) => withRetry(fn, retry);

  async function getFileContent(
    repoFullName: string,
    path: string,
    ref: string,
    maxBytes: number = maxBytesDefault,
  ): Promise<string | null> {
    const target = splitFullName(repoFullName);
    let data: Awaited<ReturnType<Octokit['rest']['repos']['getContent']>>['data'];
    try {
      ({ data } = await call(() => octokit.rest.repos.getContent({ ...target, path, ref })));
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw toGitHubError(err, 'reading a file');
    }
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
    // Files over 1MB come back with encoding "none" and no content.
    if (data.size > maxBytes || data.encoding !== 'base64') return null;
    const buf = Buffer.from(data.content, 'base64');
    if (buf.byteLength > maxBytes || hasBinaryBytes(buf)) return null;
    return buf.toString('utf8');
  }

  return {
    async getPullRequest(number) {
      try {
        const { data } = await call(() => octokit.rest.pulls.get({ owner, repo, pull_number: number }));
        const baseFullName = data.base.repo.full_name;
        // A deleted fork has head.repo === null; its commits stay reachable in the base repo.
        const headRepoFullName = data.head.repo?.full_name ?? baseFullName;
        return {
          owner,
          repo,
          number: data.number,
          title: data.title,
          body: data.body ?? '',
          author: data.user?.login ?? 'ghost',
          htmlUrl: data.html_url,
          baseRef: data.base.ref,
          baseSha: data.base.sha,
          headRef: data.head.ref,
          headSha: data.head.sha,
          headRepoFullName,
          isFork: data.head.repo === null || headRepoFullName.toLowerCase() !== baseFullName.toLowerCase(),
          draft: data.draft ?? false,
          labels: data.labels.map((l) => l.name),
        };
      } catch (err) {
        throw toGitHubError(err, `reading pull request #${number}`);
      }
    },

    async listChangedFiles(pr) {
      const files: ChangedFile[] = [];
      try {
        const pages = octokit.paginate
          .iterator(octokit.rest.pulls.listFiles, {
            owner: pr.owner,
            repo: pr.repo,
            pull_number: pr.number,
            per_page: PER_PAGE,
          })
          [Symbol.asyncIterator]();
        // A failed next() leaves the iterator on the same page, so retrying it re-fetches only that page.
        while (files.length < maxFiles) {
          const page = await call(() => pages.next());
          if (page.done) break;
          for (const f of page.value.data) {
            if (files.length >= maxFiles) break;
            files.push({
              path: f.filename,
              ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
              status: FILE_STATUSES.includes(f.status) ? f.status : 'modified',
              additions: f.additions,
              deletions: f.deletions,
              ...(f.patch ? { patch: f.patch } : {}),
              patchMissing: !f.patch,
            });
          }
        }
      } catch (err) {
        throw toGitHubError(err, 'listing pull request files');
      }

      // CTX-03 — head content for AST languages only; files without a patch have no hunks to expand.
      const wanted = files.filter(
        (f) => f.status !== 'removed' && !f.patchMissing && astExtensions.has(extensionOf(f.path)),
      );
      let failed = 0;
      await mapLimit(wanted, concurrency, async (f) => {
        try {
          const content = await getFileContent(pr.headRepoFullName, f.path, pr.headSha);
          if (content !== null) f.headContent = content;
        } catch (err) {
          if (isAbortError(err) || (statusOf(err) === undefined && !(err instanceof QtgError))) throw err;
          failed++; // preprocess falls back to ±N lines without head content
        }
      });
      const withContent = wanted.filter((f) => f.headContent !== undefined).length;
      logger?.info(
        `Changed files: ${files.length} (${files.filter((f) => f.patchMissing).length} without patch); ` +
          `head content ${withContent}/${wanted.length}${failed ? `, ${failed} failed` : ''}.`,
      );
      if (failed) logger?.warn(`Could not read head content for ${failed} file(s); using line context.`);
      return files;
    },

    getFileContent,

    async getRepoConfigText(pr, path) {
      // CTX-04 / §4.3 — base SHA, so a PR cannot rewrite its own prompt or filters.
      return getFileContent(`${pr.owner}/${pr.repo}`, path, pr.baseSha);
    },

    async listPathsChangedBetween(pr, fromSha, toSha) {
      try {
        const { data } = await call(() =>
          octokit.rest.repos.compareCommitsWithBasehead({
            owner: pr.owner,
            repo: pr.repo,
            basehead: `${fromSha}...${toSha}`,
            per_page: 1,
          }),
        );
        const files = data.files ?? [];
        // Possibly truncated: report "unknown" (empty) so TRG-04 never skips on partial evidence.
        if (files.length >= COMPARE_FILE_CAP) return [];
        const paths = new Set<string>();
        for (const f of files) {
          paths.add(f.filename);
          if (f.previous_filename) paths.add(f.previous_filename);
        }
        return [...paths];
      } catch (err) {
        // The old SHA can vanish after a force-push; treat as unknown rather than failing the run.
        const status = statusOf(err);
        if (status === 404 || status === 422) return [];
        throw toGitHubError(err, 'comparing commits');
      }
    },
  };
}
