import { describe, expect, it, vi } from 'vitest';
import { PrdFetchError } from '../../../src/context/prd/errors';
import { createJiraProvider } from '../../../src/context/prd/jira';
import { createNotionProvider } from '../../../src/context/prd/notion';
import { collectPrdDocuments } from '../../../src/context/prd/registry';
import type { PrdDocument, PrdProvider, PrdRef, PrdSource } from '../../../src/core/contracts';
import { fakeFetch, json } from '../helpers';

const ref = (source: PrdSource, id: string): PrdRef => ({ source, id, raw: id });
const doc = (r: PrdRef, body = 'TOP SECRET PRD BODY'): PrdDocument => ({
  ref: r,
  title: `title ${r.id}`,
  bodyMarkdown: body,
  acceptanceCriteria: [],
  url: `https://example.com/${r.id}`,
  meta: {},
});

function provider(
  source: PrdSource,
  fetch: PrdProvider['fetch'] = async (r) => doc(r),
  configured = true,
): PrdProvider & { fetch: ReturnType<typeof vi.fn> } {
  return { source, isConfigured: () => configured, fetch: vi.fn(fetch) };
}

const opts = (over: Partial<{ timeoutMs: number; signal: AbortSignal }> = {}) => ({
  timeoutMs: 15_000,
  signal: new AbortController().signal,
  ...over,
});

describe('collectPrdDocuments', () => {
  it('PRD-02 dispatches each ref to the provider registered for its source, keeping ref order', async () => {
    const gh = provider('github', async (r) => {
      await new Promise((res) => setTimeout(res, 20));
      return doc(r);
    });
    const jira = provider('jira');
    const refs = [ref('github', 'acme/shop#1'), ref('jira', 'PROJ-1'), ref('github', 'acme/shop#2')];
    const { documents, warnings } = await collectPrdDocuments(refs, [gh, jira], opts());
    expect(documents.map((d) => d.ref.id)).toEqual(['acme/shop#1', 'PROJ-1', 'acme/shop#2']);
    expect(warnings).toEqual([]);
    expect(gh.fetch).toHaveBeenCalledTimes(2);
    expect(jira.fetch).toHaveBeenCalledTimes(1);
  });

  it('PRD-02 fetches documents in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = provider('github', async (r) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 15));
      inFlight--;
      return doc(r);
    });
    await collectPrdDocuments(
      [ref('github', 'a/b#1'), ref('github', 'a/b#2'), ref('github', 'a/b#3')],
      [slow],
      opts(),
    );
    expect(peak).toBe(3);
  });

  it('PRD-09 warns once per unconfigured or unregistered source and skips its refs', async () => {
    const jira = provider('jira', undefined, false);
    const refs = [ref('jira', 'PROJ-1'), ref('notion', 'abc'), ref('jira', 'PROJ-2')];
    const { documents, warnings } = await collectPrdDocuments(refs, [jira], opts());
    expect(documents).toEqual([]);
    expect(jira.fetch).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      {
        code: 'prd_source_unconfigured',
        message:
          'Jira is not configured (set jira-base-url, jira-email and jira-api-token); skipped PROJ-1, PROJ-2.',
      },
      {
        code: 'prd_source_unconfigured',
        message: 'Notion is not configured (set notion-token); skipped abc.',
      },
    ]);
  });

  it('PRD-08 turns failures into warnings and keeps going', async () => {
    const jira = provider('jira', async (r) => {
      if (r.id === 'PROJ-1')
        throw new PrdFetchError('not_found', 'Jira issue PROJ-1 was not found (HTTP 404).');
      return doc(r);
    });
    const { documents, warnings } = await collectPrdDocuments(
      [ref('jira', 'PROJ-1'), ref('jira', 'PROJ-2')],
      [jira],
      opts(),
    );
    expect(documents.map((d) => d.ref.id)).toEqual(['PROJ-2']);
    expect(warnings).toEqual([
      {
        code: 'prd_fetch_failed',
        message: 'Could not fetch PROJ-1 (Jira): Jira issue PROJ-1 was not found (HTTP 404).',
      },
    ]);
  });

  it('PRD-10 maps GitHub permission failures to prd_permission', async () => {
    const gh = provider('github', async () => {
      throw new PrdFetchError(
        'permission',
        'Cannot read other/private#3 (HTTP 404): needs a PAT or GitHub App token.',
      );
    });
    const { warnings } = await collectPrdDocuments([ref('github', 'other/private#3')], [gh], opts());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('prd_permission');
    expect(warnings[0]?.message).toContain('PAT or GitHub App token');
  });

  it('PRD-10 reports Jira 401/403 and Notion 404 (not shared) as prd_permission end to end', async () => {
    const jiraStatus: Record<string, number> = { 'PROJ-1': 401, 'PROJ-2': 403, 'PROJ-3': 404 };
    const jiraHttp = fakeFetch((req) =>
      json({ errorMessages: ['x'] }, jiraStatus[req.url.pathname.split('/').pop() ?? ''] ?? 500),
    );
    const notionHttp = fakeFetch(() =>
      json({ object: 'error', status: 404, code: 'object_not_found', message: 'x' }, 404),
    );
    const jira = createJiraProvider(
      { baseUrl: 'https://acme.atlassian.net', email: 'e@example.com', apiToken: 't' },
      { fetch: jiraHttp.fetch as typeof fetch },
    );
    const notion = createNotionProvider('n', { fetch: notionHttp.fetch });
    const { warnings } = await collectPrdDocuments(
      [ref('jira', 'PROJ-1'), ref('jira', 'PROJ-2'), ref('jira', 'PROJ-3'), ref('notion', 'a'.repeat(32))],
      [jira, notion],
      opts(),
    );
    expect(warnings.map((w) => w.code)).toEqual([
      'prd_permission',
      'prd_permission',
      'prd_fetch_failed',
      'prd_permission',
    ]);
    expect(warnings[3]?.message).toContain('not shared with the integration');
  });

  it('PRD-08 times out a slow document after timeoutMs without blocking the others', async () => {
    const notion = provider('notion', (r, signal) =>
      r.id === 'slow'
        ? new Promise<PrdDocument>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          )
        : Promise.resolve(doc(r)),
    );
    const started = Date.now();
    const { documents, warnings } = await collectPrdDocuments(
      [ref('notion', 'slow'), ref('notion', 'fast')],
      [notion],
      opts({ timeoutMs: 30 }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(documents.map((d) => d.ref.id)).toEqual(['fast']);
    expect(warnings).toEqual([
      { code: 'prd_fetch_failed', message: 'Timed out after 0s fetching slow (Notion).' },
    ]);
  });

  it('PRD-08 times out even when the provider ignores its signal', async () => {
    const stuck = provider('github', () => new Promise<PrdDocument>(() => undefined));
    const { warnings } = await collectPrdDocuments(
      [ref('github', 'a/b#1')],
      [stuck],
      opts({ timeoutMs: 1_500 }),
    );
    expect(warnings).toEqual([
      { code: 'prd_fetch_failed', message: 'Timed out after 2s fetching a/b#1 (GitHub).' },
    ]);
  });

  it('PRD-08 never puts PRD text or raw error messages into warnings', async () => {
    const gh = provider('github', async () => {
      throw new SyntaxError('Unexpected token < in "TOP SECRET PRD BODY"');
    });
    const plain = provider('jira', async () => {
      throw new Error('TOP SECRET PRD BODY');
    });
    const { warnings } = await collectPrdDocuments(
      [ref('github', 'a/b#1'), ref('jira', 'PROJ-1')],
      [gh, plain],
      opts(),
    );
    expect(warnings).toEqual([
      {
        code: 'prd_fetch_failed',
        message: 'Could not fetch a/b#1 (GitHub): unexpected error (SyntaxError).',
      },
      { code: 'prd_fetch_failed', message: 'Could not fetch PROJ-1 (Jira): unexpected error.' },
    ]);
    expect(JSON.stringify(warnings)).not.toContain('SECRET');
  });

  it('PRD-08 passes a combined signal that aborts with the run', async () => {
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    const gh = provider('github', (_r, signal) => {
      seen = signal;
      return new Promise<PrdDocument>(() => undefined);
    });
    const p = collectPrdDocuments([ref('github', 'a/b#1')], [gh], opts({ signal: ctrl.signal }));
    await new Promise((res) => setTimeout(res, 5));
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen?.aborted).toBe(true);
  });

  it('PRD-08 rejects immediately when the run is already cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      collectPrdDocuments([ref('github', 'a/b#1')], [provider('github')], opts({ signal: ctrl.signal })),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('PRD-02 uses the first provider registered for a source and handles no refs', async () => {
    const first = provider('github');
    const second = provider('github');
    await collectPrdDocuments([ref('github', 'a/b#1')], [first, second], opts());
    expect(first.fetch).toHaveBeenCalledTimes(1);
    expect(second.fetch).not.toHaveBeenCalled();
    await expect(collectPrdDocuments([], [first], opts())).resolves.toEqual({ documents: [], warnings: [] });
  });
});
