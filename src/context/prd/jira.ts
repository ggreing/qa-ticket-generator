/** Jira Cloud PRD provider: REST v3 + ADF to Markdown (PRD-04/07). Owner: qa-work-session-a. */
import type { PrdDocument, PrdProvider } from '../../core/contracts';
import { type RetryOptions, statusOf, withRetry } from '../retry';
import { extractAcceptanceCriteria, extractListItems } from './ac';
import { adfToMarkdown } from './adf-to-md';
import { HttpStatusError, PrdFetchError } from './errors';

export interface JiraOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  acceptanceCriteriaField?: string;
}

/** Test seams. */
export interface JiraDeps {
  fetch?: typeof fetch;
  retry?: RetryOptions;
}

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string | null;
    description?: unknown;
    status?: { name?: string } | null;
    issuetype?: { name?: string } | null;
    [field: string]: unknown;
  };
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const FIELD_ID = /^[A-Za-z0-9_.-]+$/;

const isAdf = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'doc';

/** Markdown for a field that may be ADF (rich text), plain text, or a list of either. */
function fieldToMarkdown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (isAdf(value)) return adfToMarkdown(value);
  if (Array.isArray(value)) {
    return value
      .map(fieldToMarkdown)
      .filter(Boolean)
      .map((s) => `- ${s.replace(/\n/g, ' ')}`)
      .join('\n');
  }
  return '';
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

function toFetchError(err: unknown, key: string): unknown {
  if (err instanceof PrdFetchError) return err;
  const status = statusOf(err);
  if (status === undefined) return err; // aborts/timeouts are classified by the registry
  // PRD-10 — both are fixed by the user's Jira credentials/permissions, so report them as such.
  if (status === 401) {
    return new PrdFetchError(
      'permission',
      `Jira rejected the credentials for ${key} (HTTP 401); check jira-email and jira-api-token.`,
      { status },
    );
  }
  if (status === 403) {
    return new PrdFetchError(
      'permission',
      `The Jira account may not read ${key} (HTTP 403); grant it "Browse projects" on that project.`,
      { status },
    );
  }
  if (status === 404) {
    return new PrdFetchError(
      'not_found',
      `Jira issue ${key} was not found or is not visible to the account (HTTP 404).`,
      {
        status,
      },
    );
  }
  return new PrdFetchError('http', `Jira request for ${key} failed (HTTP ${status}).`, { status });
}

/**
 * PRD-04 — Jira Cloud provider. Reads `GET {baseUrl}/rest/api/3/issue/{key}` with Basic auth
 * (email:API token) and converts the ADF description to Markdown. When
 * `acceptanceCriteriaField` is set, that custom field (ADF or text) supplies the acceptance
 * criteria and is appended to the body; otherwise they are extracted from the description (PRD-07).
 *
 * @param options Resolved `jira-*` inputs, or null when Jira is not configured (PRD-09).
 * @param deps Optional `fetch` / retry overrides for tests.
 */
export function createJiraProvider(options: JiraOptions | null, deps: JiraDeps = {}): PrdProvider {
  const doFetch = deps.fetch ?? globalThis.fetch;
  return {
    source: 'jira',
    isConfigured: () => options !== null,
    async fetch(ref, signal): Promise<PrdDocument> {
      if (!options) throw new PrdFetchError('invalid_ref', 'Jira is not configured.');
      const key = ref.id.trim().toUpperCase();
      if (!ISSUE_KEY.test(key))
        throw new PrdFetchError('invalid_ref', 'The reference is not a valid Jira issue key.');
      const base = options.baseUrl.replace(/\/+$/, '');
      if (ref.url && originOf(ref.url) !== originOf(base)) {
        throw new PrdFetchError('invalid_ref', `${key} links to a different Jira site than jira-base-url.`);
      }
      const acField = options.acceptanceCriteriaField?.trim();
      if (acField && !FIELD_ID.test(acField)) {
        throw new PrdFetchError('invalid_ref', 'jiraAcceptanceCriteriaField is not a valid Jira field id.');
      }

      const fields = ['summary', 'description', 'status', 'issuetype', ...(acField ? [acField] : [])];
      const url = `${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`;
      const auth = Buffer.from(`${options.email}:${options.apiToken}`).toString('base64');

      let issue: JiraIssue;
      try {
        const res = await withRetry(
          async () => {
            const r = await doFetch(url, {
              headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
              signal,
            });
            if (!r.ok) {
              await r.body?.cancel().catch(() => undefined);
              throw new HttpStatusError(r.status, Object.fromEntries(r.headers));
            }
            return r;
          },
          { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, ...deps.retry },
          signal,
        );
        issue = (await res.json().catch(() => {
          throw new PrdFetchError('http', `Jira returned an unreadable response for ${key}.`);
        })) as JiraIssue;
      } catch (err) {
        throw toFetchError(err, key);
      }

      const f = issue.fields ?? {};
      const description = fieldToMarkdown(f.description);
      const acMarkdown = acField ? fieldToMarkdown(f[acField]) : '';
      const acceptanceCriteria = acMarkdown
        ? extractListItems(acMarkdown)
        : extractAcceptanceCriteria(description);
      const bodyMarkdown = acMarkdown
        ? `${description}\n\n## Acceptance Criteria\n\n${acMarkdown}`.trim()
        : description;
      const resolvedKey = typeof issue.key === 'string' && ISSUE_KEY.test(issue.key) ? issue.key : key;

      return {
        ref,
        title: f.summary?.trim() || resolvedKey,
        bodyMarkdown,
        acceptanceCriteria,
        url: `${base}/browse/${resolvedKey}`,
        meta: {
          key: resolvedKey,
          ...(f.status?.name ? { status: f.status.name } : {}),
          ...(f.issuetype?.name ? { issueType: f.issuetype.name } : {}),
        },
      };
    },
  };
}
