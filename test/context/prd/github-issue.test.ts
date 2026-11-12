import { describe, expect, it } from 'vitest';
import { PrdFetchError } from '../../../src/context/prd/errors';
import { createGitHubIssueProvider } from '../../../src/context/prd/github-issue';
import type { PrdRef } from '../../../src/core/contracts';
import { fakeOctokit, hang, instantSleep, json } from '../helpers';

const ref = (id: string): PrdRef => ({ source: 'github', id, raw: id });
const signal = () => new AbortController().signal;

const issue = {
  number: 7,
  title: 'Coupon PRD',
  body: '## Acceptance Criteria\n- [ ] applies once\n- [ ] rejects expired\n\n## Notes\n- not AC',
  html_url: 'https://github.com/acme/shop/issues/7',
  state: 'open',
  labels: [{ name: 'prd' }, 'legacy-string-label', { name: null }],
};

describe('createGitHubIssueProvider', () => {
  it('PRD-06 fetches title, body and labels and extracts AC', async () => {
    const { octokit, calls } = fakeOctokit((req) =>
      req.url.pathname === '/repos/acme/shop/issues/7' ? json(issue) : json({}, 404),
    );
    const p = createGitHubIssueProvider(octokit);
    expect(p.source).toBe('github');
    expect(p.isConfigured()).toBe(true);
    const doc = await p.fetch(ref('acme/shop#7'), signal());
    expect(doc).toEqual({
      ref: ref('acme/shop#7'),
      title: 'Coupon PRD',
      bodyMarkdown: issue.body,
      acceptanceCriteria: ['applies once', 'rejects expired'],
      url: 'https://github.com/acme/shop/issues/7',
      meta: {
        repository: 'acme/shop',
        number: '7',
        state: 'open',
        kind: 'issue',
        labels: 'prd, legacy-string-label',
      },
    });
    expect(calls).toHaveLength(1);
  });

  it('PRD-06 reads issues of other repositories and PRs used as PRDs', async () => {
    const { octokit, calls } = fakeOctokit(() =>
      json({ ...issue, number: 3, body: null, labels: [], pull_request: { url: 'x' } }),
    );
    const doc = await createGitHubIssueProvider(octokit).fetch(ref('other/lib#3'), signal());
    expect(calls[0]?.url.pathname).toBe('/repos/other/lib/issues/3');
    expect(doc.bodyMarkdown).toBe('');
    expect(doc.acceptanceCriteria).toEqual([]);
    expect(doc.meta).toEqual({ repository: 'other/lib', number: '3', state: 'open', kind: 'pull_request' });
  });

  it('PRD-10 turns 403/404 into a permission error that mentions PAT / GitHub App', async () => {
    for (const status of [403, 404]) {
      const { octokit } = fakeOctokit(() => json({ message: 'Not Found' }, status));
      const err = (await createGitHubIssueProvider(octokit)
        .fetch(ref('private/repo#1'), signal())
        .catch((e: unknown) => e)) as PrdFetchError;
      expect(err).toBeInstanceOf(PrdFetchError);
      expect(err.kind).toBe('permission');
      expect(err.message).toContain('PAT or GitHub App token');
    }
  });

  it('PRD-10 does not mistake an exhausted rate limit for missing permission', async () => {
    const { sleep } = instantSleep();
    const { octokit } = fakeOctokit(() =>
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1',
      }),
    );
    const err = (await createGitHubIssueProvider(octokit, { retry: { sleep } })
      .fetch(ref('acme/shop#1'), signal())
      .catch((e: unknown) => e)) as PrdFetchError;
    expect(err.kind).toBe('http');
  });

  it('PRD-08 maps 410 and 5xx (after retries) to fetch failures', async () => {
    const { sleep, delays } = instantSleep();
    const gone = fakeOctokit(() => json({ message: 'gone' }, 410));
    await expect(createGitHubIssueProvider(gone.octokit).fetch(ref('a/b#1'), signal())).rejects.toMatchObject(
      {
        kind: 'not_found',
      },
    );
    const down = fakeOctokit(() => json({ message: 'down' }, 502));
    await expect(
      createGitHubIssueProvider(down.octokit, { retry: { sleep } }).fetch(ref('a/b#1'), signal()),
    ).rejects.toMatchObject({ kind: 'http', status: 502 });
    expect(down.calls).toHaveLength(3);
    expect(delays).toEqual([500, 1000]);
  });

  it('PRD-06 rejects malformed ids and propagates aborts', async () => {
    const { octokit } = fakeOctokit(() => hang());
    const p = createGitHubIssueProvider(octokit);
    await expect(p.fetch(ref('just-text'), signal())).rejects.toMatchObject({ kind: 'invalid_ref' });
    const ctrl = new AbortController();
    const pending = p.fetch(ref('acme/shop#1'), ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
