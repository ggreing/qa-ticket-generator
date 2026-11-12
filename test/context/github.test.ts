import { describe, expect, it } from 'vitest';
import { createGitHubReader, type GitHubReaderOptions } from '../../src/context/github';
import { QtgError } from '../../src/core/errors';
import { fakePr, silentLogger } from '../helpers/fakes';
import { fakeOctokit, type Handler, instantSleep, json, type RecordedRequest } from './helpers';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function prPayload(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Apply coupon at checkout',
    body: 'Closes #7',
    user: { login: 'dev' },
    html_url: 'https://github.com/acme/shop/pull/42',
    draft: false,
    labels: [{ name: 'needs-ai-qa' }, { name: 'backend' }],
    base: { ref: 'main', sha: BASE, repo: { full_name: 'acme/shop' } },
    head: { ref: 'feat/coupon', sha: HEAD, repo: { full_name: 'acme/shop' } },
    ...over,
  };
}

function file(i: number, over: Record<string, unknown> = {}) {
  return {
    filename: `src/f${i}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1 +1 @@\n-a\n+b',
    ...over,
  };
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

function contentPayload(text: string | Buffer, over: Record<string, unknown> = {}) {
  const buf = Buffer.from(text);
  return { type: 'file', encoding: 'base64', size: buf.byteLength, content: b64(buf), ...over };
}

/** Routes requests by path; `contents` maps "owner/repo:path@ref" to a handler result. */
function api(routes: Record<string, (req: RecordedRequest) => Response | Promise<Response>>): Handler {
  return (req) => {
    const path = decodeURIComponent(req.url.pathname);
    for (const [pattern, fn] of Object.entries(routes)) {
      if (new RegExp(`^${pattern}$`).test(path)) return fn(req);
    }
    return json({ message: 'Not Found' }, 404);
  };
}

function reader(handler: Handler, opts: Partial<GitHubReaderOptions> = {}) {
  const { octokit, calls } = fakeOctokit(handler);
  const { sleep, delays } = instantSleep();
  const logger = silentLogger();
  const r = createGitHubReader(octokit, {
    owner: 'acme',
    repo: 'shop',
    astExtensions: ['.ts', 'py'],
    retry: { sleep },
    logger,
    ...opts,
  });
  return { r, calls, delays, logger };
}

describe('createGitHubReader.getPullRequest', () => {
  it('CTX-01 maps PR metadata', async () => {
    const { r, calls } = reader(api({ '/repos/acme/shop/pulls/42': () => json(prPayload()) }));
    const pr = await r.getPullRequest(42);
    expect(pr).toEqual({
      owner: 'acme',
      repo: 'shop',
      number: 42,
      title: 'Apply coupon at checkout',
      body: 'Closes #7',
      author: 'dev',
      htmlUrl: 'https://github.com/acme/shop/pull/42',
      baseRef: 'main',
      baseSha: BASE,
      headRef: 'feat/coupon',
      headSha: HEAD,
      headRepoFullName: 'acme/shop',
      isFork: false,
      draft: false,
      labels: ['needs-ai-qa', 'backend'],
    });
    expect(calls[0]?.headers.authorization).toBe('token test-token');
  });

  it('CTX-01 detects forks, null bodies and deleted head repos', async () => {
    const fork = prPayload({
      body: null,
      user: null,
      draft: true,
      head: { ref: 'patch-1', sha: HEAD, repo: { full_name: 'outsider/shop' } },
    });
    const { r } = reader(api({ '/repos/acme/shop/pulls/42': () => json(fork) }));
    const pr = await r.getPullRequest(42);
    expect(pr).toMatchObject({
      body: '',
      author: 'ghost',
      isFork: true,
      draft: true,
      headRepoFullName: 'outsider/shop',
    });

    const deleted = prPayload({ head: { ref: 'patch-1', sha: HEAD, repo: null } });
    const { r: r2 } = reader(api({ '/repos/acme/shop/pulls/42': () => json(deleted) }));
    expect(await r2.getPullRequest(42)).toMatchObject({ isFork: true, headRepoFullName: 'acme/shop' });
  });

  it('CTX-05 retries 5xx and secondary rate limits, then succeeds', async () => {
    let n = 0;
    const { r, delays, logger } = reader(
      api({
        '/repos/acme/shop/pulls/42': () => {
          n++;
          if (n === 1) return json({ message: 'Server Error' }, 502);
          if (n === 2)
            return json({ message: 'You have exceeded a secondary rate limit' }, 403, { 'retry-after': '2' });
          return json(prPayload());
        },
      }),
    );
    await expect(r.getPullRequest(42)).resolves.toMatchObject({ number: 42 });
    expect(n).toBe(3);
    expect(delays).toEqual([1_000, 2_000]);
    expect(logger.lines.some((l) => l.includes('retry 1'))).toBe(true);
  });

  it('CTX-05 gives up after 3 retries with a github_api error', async () => {
    let n = 0;
    const { r } = reader(
      api({
        '/repos/acme/shop/pulls/42': () => {
          n++;
          return json({ message: 'unavailable' }, 503);
        },
      }),
    );
    const err = await r.getPullRequest(42).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QtgError);
    expect((err as QtgError).code).toBe('github_api');
    expect((err as QtgError).userMessage).toContain('HTTP 503');
    expect(n).toBe(4);
  });

  it('CTX-05 lets aborts through as AbortError (not github_api), without retrying', async () => {
    const { r, calls } = reader(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expect(r.getPullRequest(42)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
    await expect(r.listChangedFiles(fakePr())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('CTX-03 lets an abort during head-content fetches through', async () => {
    const { r } = reader(
      api({
        '/repos/acme/shop/pulls/42/files': () => json([file(0, { filename: 'src/a.ts' })]),
        '/repos/acme/shop/contents/src/a.ts': () => {
          throw new DOMException('aborted', 'AbortError');
        },
      }),
    );
    await expect(r.listChangedFiles(fakePr())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('CTX-05 does not retry 404', async () => {
    const { r, calls } = reader(api({}));
    await expect(r.getPullRequest(42)).rejects.toMatchObject({ code: 'github_api' });
    expect(calls).toHaveLength(1);
  });
});

describe('createGitHubReader.listChangedFiles', () => {
  it('CTX-02 paginates, maps fields and marks missing patches', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => file(i, { filename: `docs/f${i}.md` }));
    const page2 = [
      file(100, { filename: 'img/logo.png', status: 'added', patch: undefined }),
      file(101, { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed' }),
    ];
    const { r, calls } = reader(
      api({
        '/repos/acme/shop/pulls/42/files': (req) => {
          const page = req.url.searchParams.get('page') ?? '1';
          if (page === '1') {
            return json(page1, 200, {
              link: '<https://api.github.com/repositories/1/pulls/42/files?per_page=100&page=2>; rel="next"',
            });
          }
          return json(page2);
        },
        '/repositories/1/pulls/42/files': () => json(page2),
        '/repos/acme/shop/contents/src/new.ts': () => json(contentPayload('export const x = 1;\n')),
      }),
    );
    const files = await r.listChangedFiles(fakePr());
    expect(files).toHaveLength(102);
    expect(calls[0]?.url.searchParams.get('per_page')).toBe('100');
    expect(files[100]).toEqual({
      path: 'img/logo.png',
      status: 'added',
      additions: 1,
      deletions: 0,
      patchMissing: true,
    });
    expect(files[101]).toMatchObject({
      path: 'src/new.ts',
      previousPath: 'src/old.ts',
      status: 'renamed',
      patchMissing: false,
      patch: '@@ -1 +1 @@\n-a\n+b',
      headContent: 'export const x = 1;\n',
    });
  });

  it('CTX-02 stops at 3000 files', async () => {
    let pages = 0;
    const { r } = reader(
      api({
        '/repos/acme/shop/pulls/42/files': (req) => {
          pages++;
          const page = Number(req.url.searchParams.get('page') ?? '1');
          const data = Array.from({ length: 100 }, (_, i) =>
            file(page * 100 + i, { filename: `d/${page}-${i}.md` }),
          );
          return json(data, 200, {
            link: `<https://api.github.com/repos/acme/shop/pulls/42/files?per_page=100&page=${page + 1}>; rel="next"`,
          });
        },
      }),
    );
    const files = await r.listChangedFiles(fakePr());
    expect(files).toHaveLength(3000);
    expect(pages).toBe(30);
  });

  it('CTX-05 retries a failed page without restarting pagination', async () => {
    const seen: string[] = [];
    let failedOnce = false;
    const { r } = reader(
      api({
        '/repos/acme/shop/pulls/42/files': (req) => {
          const page = req.url.searchParams.get('page') ?? '1';
          seen.push(page);
          if (page === '2' && !failedOnce) {
            failedOnce = true;
            return json({ message: 'bad gateway' }, 502);
          }
          if (page === '1') {
            return json([file(1, { filename: 'a.md' })], 200, {
              link: '<https://api.github.com/repos/acme/shop/pulls/42/files?per_page=100&page=2>; rel="next"',
            });
          }
          return json([file(2, { filename: 'b.md' })]);
        },
      }),
    );
    const files = await r.listChangedFiles(fakePr());
    expect(files.map((f) => f.path)).toEqual(['a.md', 'b.md']);
    expect(seen).toEqual(['1', '2', '2']);
  });

  it('CTX-03 fetches head content only for AST files at head SHA of the head repo, 5 at a time', async () => {
    const list = [
      file(0, { filename: 'src/a.ts' }),
      file(1, { filename: 'src/b.TS' }),
      file(2, { filename: 'tool/c.py' }),
      file(3, { filename: 'README.md' }),
      file(4, { filename: 'src/gone.ts', status: 'removed' }),
      file(5, { filename: 'src/huge.ts', patch: undefined }),
      file(6, { filename: 'src/big.ts' }),
      file(7, { filename: 'src/bin.ts' }),
      file(8, { filename: 'src/dir.ts' }),
      ...Array.from({ length: 8 }, (_, i) => file(10 + i, { filename: `src/m${i}.ts` })),
    ];
    let inFlight = 0;
    let peak = 0;
    const contentRefs = new Set<string>();
    const { r, calls, logger } = reader(
      api({
        '/repos/acme/shop/pulls/42/files': () => json(list),
        '/repos/outsider/shop/contents/(.+)': async (req) => {
          contentRefs.add(req.url.searchParams.get('ref') ?? '');
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((res) => setTimeout(res, 5));
          inFlight--;
          const path = decodeURIComponent(req.url.pathname).replace('/repos/outsider/shop/contents/', '');
          if (path === 'src/big.ts')
            return json(contentPayload('x', { size: 2 * 1024 * 1024, content: '', encoding: 'none' }));
          if (path === 'src/bin.ts') return json(contentPayload(Buffer.from([0x61, 0x00, 0x62])));
          if (path === 'src/dir.ts') return json([{ type: 'file', name: 'x' }]);
          if (path === 'src/m0.ts') return json({ message: 'boom' }, 500);
          return json(contentPayload(`// ${path}`));
        },
      }),
    );
    const files = await r.listChangedFiles(fakePr({ isFork: true, headRepoFullName: 'outsider/shop' }));
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('src/a.ts')?.headContent).toBe('// src/a.ts');
    expect(byPath.get('src/b.TS')?.headContent).toBe('// src/b.TS');
    expect(byPath.get('tool/c.py')?.headContent).toBe('// tool/c.py');
    for (const p of [
      'README.md',
      'src/gone.ts',
      'src/huge.ts',
      'src/big.ts',
      'src/bin.ts',
      'src/dir.ts',
      'src/m0.ts',
    ]) {
      expect(byPath.get(p)?.headContent, p).toBeUndefined();
    }
    expect(contentRefs).toEqual(new Set([HEAD]));
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
    const fetchedPaths = calls.map((c) => decodeURIComponent(c.url.pathname));
    expect(fetchedPaths).not.toContain('/repos/outsider/shop/contents/README.md');
    expect(fetchedPaths).not.toContain('/repos/outsider/shop/contents/src/gone.ts');
    expect(fetchedPaths).not.toContain('/repos/outsider/shop/contents/src/huge.ts');
    // OBS-01: counts only.
    expect(logger.lines.join('\n')).not.toContain('// src');
    expect(logger.lines.some((l) => l.startsWith('warn: Could not read head content for 1 file'))).toBe(true);
  });

  it('CTX-03 respects a custom maxContentBytes', async () => {
    const { r } = reader(
      api({
        '/repos/acme/shop/pulls/42/files': () => json([file(0, { filename: 'src/a.ts' })]),
        '/repos/acme/shop/contents/src/a.ts': () => json(contentPayload('0123456789')),
      }),
      { maxContentBytes: 5 },
    );
    const [f] = await r.listChangedFiles(fakePr());
    expect(f?.headContent).toBeUndefined();
  });

  it('CTX-02 wraps API failures as github_api', async () => {
    const { r } = reader(api({ '/repos/acme/shop/pulls/42/files': () => json({ message: 'nope' }, 401) }));
    await expect(r.listChangedFiles(fakePr())).rejects.toMatchObject({ code: 'github_api' });
  });
});

describe('createGitHubReader.getFileContent / getRepoConfigText', () => {
  it('CTX-03 decodes UTF-8 content and returns null when missing', async () => {
    const { r } = reader(
      api({
        '/repos/o/r/contents/a.txt': (req) =>
          req.url.searchParams.get('ref') === 'abc' ? json(contentPayload('héllo ✓')) : json({}, 404),
      }),
    );
    await expect(r.getFileContent('o/r', 'a.txt', 'abc')).resolves.toBe('héllo ✓');
    await expect(r.getFileContent('o/r', 'missing.txt', 'abc')).resolves.toBeNull();
    await expect(r.getFileContent('o/r', 'a.txt', 'abc', 3)).resolves.toBeNull();
  });

  it('CTX-03 rejects malformed repository names and non-file objects', async () => {
    const { r } = reader(api({ '/repos/o/r/contents/link': () => json({ type: 'symlink', target: 'x' }) }));
    await expect(r.getFileContent('not-a-repo', 'a', 'b')).rejects.toMatchObject({ code: 'github_api' });
    await expect(r.getFileContent('o/r', 'link', 'b')).resolves.toBeNull();
  });

  it('CTX-03 surfaces non-404 failures as github_api', async () => {
    const { r } = reader(api({ '/repos/o/r/contents/a': () => json({ message: 'forbidden' }, 403) }));
    await expect(r.getFileContent('o/r', 'a', 'b')).rejects.toMatchObject({ code: 'github_api' });
  });

  it('CTX-04 reads the repo config at the BASE sha of the base repo', async () => {
    const refs: string[] = [];
    const { r } = reader(
      api({
        '/repos/acme/shop/contents/.github/qa-ticket-generator.yml': (req) => {
          refs.push(req.url.searchParams.get('ref') ?? '');
          return json(contentPayload('prd:\n  maxDocuments: 2\n'));
        },
      }),
    );
    const text = await r.getRepoConfigText(
      fakePr({ isFork: true, headRepoFullName: 'outsider/shop' }),
      '.github/qa-ticket-generator.yml',
    );
    expect(text).toBe('prd:\n  maxDocuments: 2\n');
    expect(refs).toEqual([BASE]);
  });

  it('CTX-04 returns null when the config file is absent', async () => {
    const { r } = reader(api({}));
    await expect(r.getRepoConfigText(fakePr(), '.github/qa-ticket-generator.yml')).resolves.toBeNull();
  });
});

describe('createGitHubReader.listPathsChangedBetween', () => {
  it('TRG-04 lists paths (incl. rename sources) via the compare API', async () => {
    const seen: string[] = [];
    const { r } = reader(
      api({
        '/repos/acme/shop/compare/(.+)': (req) => {
          seen.push(decodeURIComponent(req.url.pathname));
          return json({
            files: [
              { filename: 'package-lock.json' },
              { filename: 'src/new.ts', previous_filename: 'src/old.ts' },
              { filename: 'package-lock.json' },
            ],
          });
        },
      }),
    );
    const paths = await r.listPathsChangedBetween(fakePr(), 'old1', 'new2');
    expect(paths).toEqual(['package-lock.json', 'src/new.ts', 'src/old.ts']);
    expect(seen).toEqual(['/repos/acme/shop/compare/old1...new2']);
  });

  it('TRG-04 returns [] (unknown) for truncated comparisons and vanished SHAs', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.lock` }));
    const { r } = reader(
      api({
        '/repos/acme/shop/compare/big...head': () => json({ files: many }),
        '/repos/acme/shop/compare/gone...head': () => json({ message: 'Not Found' }, 404),
        '/repos/acme/shop/compare/none...head': () => json({}),
      }),
    );
    await expect(r.listPathsChangedBetween(fakePr(), 'big', 'head')).resolves.toEqual([]);
    await expect(r.listPathsChangedBetween(fakePr(), 'gone', 'head')).resolves.toEqual([]);
    await expect(r.listPathsChangedBetween(fakePr(), 'none', 'head')).resolves.toEqual([]);
  });

  it('TRG-04 surfaces other failures as github_api', async () => {
    const { r } = reader(api({ '/repos/acme/shop/compare/(.+)': () => json({ message: 'denied' }, 401) }));
    await expect(r.listPathsChangedBetween(fakePr(), 'a', 'b')).rejects.toMatchObject({ code: 'github_api' });
  });
});
