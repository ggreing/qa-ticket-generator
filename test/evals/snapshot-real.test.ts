/** Real-PR snapshot tool (M3.5). No network: a fake GitHub behind Octokit's fetch. Owner: qa-work-session-a. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getOctokit } from '@actions/github';
import { afterAll, describe, expect, it } from 'vitest';
import { PrdDocumentSchema, PullRequestSchema } from '../../evals/schema';
import {
  main,
  prdFileName,
  type RealSource,
  RealSourcesSchema,
  readOnlyFetch,
  snapshotCase,
  writeSnapshot,
} from '../../evals/tools/snapshot-real';
import { fakeFetch, json, type RecordedRequest } from '../context/helpers';

const HEAD = '1'.repeat(40);
const instant = { sleep: async () => undefined };

const source: RealSource = {
  id: 'real-lib-12',
  repo: 'acme/lib',
  pr: 12,
  issue: 3,
  mergeSha: '2'.repeat(40),
  headSha: HEAD,
  changedFiles: 2,
  license: 'MIT',
  language: 'Python',
  domain: 'retry',
  split: 'dev',
  reason: 'Synthetic stand-in for a real PR used by the unit tests.',
};

const retryPy =
  'def retry(fn, attempts=3):\n    for i in range(attempts):\n        try:\n            return fn()\n        except Exception:\n            if i == attempts - 1:\n                raise\n';

/** Synthetic public repo: PR #12 fixes #3 and mentions acme/other#4 (body order: #3 then other#4). */
function fakeGitHub(overrides: { head?: string } = {}) {
  const handler = (req: RecordedRequest): Response => {
    const path = decodeURIComponent(req.url.pathname);
    if (path === '/repos/acme/lib/pulls/12') {
      return json({
        number: 12,
        title: 'Re-raise the last error after the final attempt',
        body: 'Fixes #3\n\nRelated: acme/other#4\n\n<!-- template example: #999 -->',
        user: { login: 'contributor' },
        html_url: 'https://github.com/acme/lib/pull/12',
        draft: false,
        labels: [{ name: 'bug' }],
        base: { ref: 'main', sha: '3'.repeat(40), repo: { full_name: 'acme/lib' } },
        head: { ref: 'fix-reraise', sha: overrides.head ?? HEAD, repo: { full_name: 'acme/lib' } },
      });
    }
    if (path === '/repos/acme/lib/pulls/12/files') {
      return json([
        {
          filename: 'lib/retry.py',
          status: 'modified',
          additions: 2,
          deletions: 1,
          patch:
            '@@ -5,3 +5,4 @@\n         except Exception:\n-            pass\n+            if i == attempts - 1:\n+                raise',
        },
        {
          filename: 'tests/test_retry.py',
          status: 'added',
          additions: 3,
          deletions: 0,
          patch: '@@ -0,0 +1,3 @@\n+def test_reraise():\n+    pass\n+',
        },
      ]);
    }
    if (path === '/repos/acme/lib/contents/lib/retry.py' && req.url.searchParams.get('ref') === HEAD) {
      const buf = Buffer.from(retryPy);
      return json({
        type: 'file',
        encoding: 'base64',
        size: buf.byteLength,
        content: buf.toString('base64'),
      });
    }
    if (path === '/repos/acme/lib/issues/3') {
      return json({
        number: 3,
        title: 'retry() swallows the last exception',
        body: '## Acceptance Criteria\n- [ ] The last exception is re-raised after the final attempt\n- [ ] Earlier failures are retried',
        html_url: 'https://github.com/acme/lib/issues/3',
        state: 'closed',
        labels: [{ name: 'bug' }],
      });
    }
    if (path === '/repos/acme/other/issues/4') {
      return json({
        number: 4,
        title: 'Document retry semantics',
        body: 'Describe what happens after the last attempt.',
        html_url: 'https://github.com/acme/other/issues/4',
        state: 'open',
        labels: [],
      });
    }
    return json({ message: 'Not Found' }, 404);
  };
  return fakeFetch(handler);
}

const octokitFor = (gh: ReturnType<typeof fakeFetch>) => getOctokit('test', { request: { fetch: gh.fetch } });

const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'qtg-real-'));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('evals/real-sources.json', () => {
  const sources = RealSourcesSchema.parse(
    JSON.parse(readFileSync(resolve('evals/real-sources.json'), 'utf8')),
  );

  it('M3.5 lists 5–10 merged PRs with pinned SHAs, permissive licenses and unique real-<repo>-<pr> ids', () => {
    expect(sources.length).toBeGreaterThanOrEqual(5);
    expect(sources.length).toBeLessThanOrEqual(10);
    for (const s of sources) {
      expect(s.id).toBe(
        `real-${s.repo
          .split('/')[1]
          ?.toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')}-${s.pr}`,
      );
      expect(s.changedFiles).toBeGreaterThanOrEqual(2);
      expect(s.changedFiles).toBeLessThanOrEqual(15);
    }
  });

  it('M3.5 mixes TypeScript, Python, Go and Java and splits dev/test about evenly', () => {
    expect(new Set(sources.map((s) => s.language))).toEqual(new Set(['TypeScript', 'Python', 'Go', 'Java']));
    const dev = sources.filter((s) => s.split === 'dev').length;
    expect(Math.abs(dev - (sources.length - dev))).toBeLessThanOrEqual(1);
    for (const lang of ['TypeScript', 'Python', 'Go', 'Java']) {
      const splits = new Set(sources.filter((s) => s.language === lang).map((s) => s.split));
      expect(splits, lang).toEqual(new Set(['dev', 'test']));
    }
  });

  it('M3.5 contains metadata only, never source code', () => {
    const raw = readFileSync(resolve('evals/real-sources.json'), 'utf8');
    expect(raw).not.toMatch(/"(patch|headContent|body|bodyMarkdown)"/);
  });

  it('M3.5 rejects duplicate ids, ids that do not end in the PR number, and non-permissive licenses', () => {
    expect(() => RealSourcesSchema.parse([source, source])).toThrow(/duplicate id/);
    expect(() => RealSourcesSchema.parse([{ ...source, id: 'real-lib-13' }])).toThrow(/must end with -12/);
    expect(() => RealSourcesSchema.parse([{ ...source, license: 'GPL-3.0' }])).toThrow();
  });
});

describe('snapshotCase', () => {
  it('M3.5 writes pr.json, files.json and body-ordered PRD files through the action modules', async () => {
    const gh = fakeGitHub();
    const { files, warnings } = await snapshotCase(source, octokitFor(gh), { retry: instant });
    expect([...files.keys()]).toEqual([
      'pr.json',
      'files.json',
      'prd/01-github-acme-lib-3.json',
      'prd/02-github-acme-other-4.json',
    ]);
    expect(warnings).toEqual([]);

    const pr = PullRequestSchema.parse(JSON.parse(files.get('pr.json') ?? ''));
    expect(pr).toMatchObject({ owner: 'acme', repo: 'lib', number: 12, headSha: HEAD, labels: ['bug'] });
    const changed = JSON.parse(files.get('files.json') ?? '') as { path: string; headContent?: string }[];
    expect(changed.map((f) => f.path)).toEqual(['lib/retry.py', 'tests/test_retry.py']);
    expect(changed[0]?.headContent).toBe(retryPy); // CTX-03 head content for an AST language
    const doc = PrdDocumentSchema.parse(JSON.parse(files.get('prd/01-github-acme-lib-3.json') ?? ''));
    expect(doc.acceptanceCriteria).toEqual([
      'The last exception is re-raised after the final attempt',
      'Earlier failures are retried',
    ]);
    // The template example inside the HTML comment was not fetched.
    expect(gh.calls.some((c) => c.url.pathname.endsWith('/issues/999'))).toBe(false);
    expect([...files.keys()].some((k) => k.endsWith('expected.json'))).toBe(false);
  });

  it('M3.5 is deterministic: the same head SHA gives byte-identical files', async () => {
    const a = await snapshotCase(source, octokitFor(fakeGitHub()), { retry: instant });
    const b = await snapshotCase(source, octokitFor(fakeGitHub()), { retry: instant });
    expect([...a.files]).toEqual([...b.files]);
    for (const content of a.files.values())
      expect(content.endsWith('}\n') || content.endsWith(']\n')).toBe(true);
  });

  it('M3.5 refuses to snapshot when the PR head no longer matches the pinned SHA', async () => {
    await expect(
      snapshotCase(source, octokitFor(fakeGitHub({ head: '9'.repeat(40) })), { retry: instant }),
    ).rejects.toThrow(/refusing to write a different snapshot/);
  });

  it('M3.5 keeps going with a warning when a linked issue cannot be read', async () => {
    const gh = fakeFetch((req) => {
      if (req.url.pathname === '/repos/acme/other/issues/4') return json({ message: 'Not Found' }, 404);
      return fakeGitHub().fetch(req.url.href, { method: req.method }) as unknown as Response;
    });
    const { files, warnings } = await snapshotCase(source, octokitFor(gh), { retry: instant });
    expect([...files.keys()].filter((k) => k.startsWith('prd/'))).toEqual(['prd/01-github-acme-lib-3.json']);
    expect(warnings.map((w) => w.code)).toEqual(['prd_permission']);
  });
});

describe('prdFileName / writeSnapshot', () => {
  it('M3.5 names PRD files NN-<source>-<id> so name order equals body order', () => {
    const doc = (id: string) => ({ ref: { source: 'github' as const, id, raw: id } }) as never;
    expect(prdFileName(0, doc('acme/lib#3'))).toBe('01-github-acme-lib-3.json');
    expect(prdFileName(9, doc('Org.Name/Repo_X#10'))).toBe('10-github-org-name-repo-x-10.json');
  });

  it('M3.5 replaces the case directory so stale PRD files disappear', () => {
    const root = tmp();
    mkdirSync(join(root, 'real-lib-12', 'prd'), { recursive: true });
    writeFileSync(join(root, 'real-lib-12', 'prd', '03-stale.json'), '{}');
    writeSnapshot(
      root,
      'real-lib-12',
      new Map([
        ['pr.json', '{}\n'],
        ['prd/01-a.json', '{}\n'],
      ]),
    );
    expect(readdirSync(join(root, 'real-lib-12', 'prd'))).toEqual(['01-a.json']);
    expect(readFileSync(join(root, 'real-lib-12', 'pr.json'), 'utf8')).toBe('{}\n');
  });
});

describe('module side effects', () => {
  it('M3.5 never starts on its own: evals/main.ts bundles it, so a self-run hook would fetch on every eval command', () => {
    const src = readFileSync(resolve('evals/tools/snapshot-real.ts'), 'utf8');
    expect(src).not.toMatch(/process\.argv/);
    expect(src).not.toMatch(/import\.meta\.url/);
    expect(src).not.toMatch(/^main\(/m);
  });
});

describe('readOnlyFetch', () => {
  it('M3.5 lets only GitHub REST GET requests through, and counts them', async () => {
    const inner = fakeFetch(() => json({ ok: true }));
    const guard = readOnlyFetch(inner.fetch as typeof fetch);
    await guard.fetch('https://api.github.com/repos/acme/lib');
    await guard.fetch('https://api.github.com/repos/acme/lib/pulls/1', { method: 'get' });
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      await expect(
        guard.fetch('https://api.github.com/repos/acme/lib/issues/1/comments', { method }),
      ).rejects.toThrow(/read-only/);
    }
    await expect(guard.fetch('https://example.com/x')).rejects.toThrow(/refusing request to example.com/);
    expect(guard.calls()).toBe(2);
    expect(inner.calls).toHaveLength(2);
  });
});

describe('main (CLI)', () => {
  const setup = (sources: RealSource[]) => {
    const dir = tmp();
    const sourcesPath = join(dir, 'real-sources.json');
    writeFileSync(sourcesPath, JSON.stringify(sources));
    const lines: string[] = [];
    return { dir, sourcesPath, lines, print: (l: string) => lines.push(l) };
  };

  it('M3.5 requires a token and never prints it', async () => {
    const s = setup([source]);
    expect(await main([], { env: {}, print: s.print, root: s.dir, sourcesPath: s.sourcesPath })).toBe(2);
    expect(s.lines.join('\n')).toContain('GITHUB_TOKEN');
  });

  it('M3.5 snapshots the selected sources, reports failures per case and prints the API call count', async () => {
    const s = setup([source, { ...source, id: 'real-lib-99', pr: 99 }]);
    const gh = fakeGitHub();
    const code = await main([], {
      env: { GITHUB_TOKEN: 'secret-token-value' },
      print: s.print,
      root: join(s.dir, 'real'),
      sourcesPath: s.sourcesPath,
      fetch: gh.fetch as typeof fetch,
    });
    expect(code).toBe(1); // PR 99 does not exist in the fake
    expect(existsSync(join(s.dir, 'real', 'real-lib-12', 'files.json'))).toBe(true);
    expect(existsSync(join(s.dir, 'real', 'real-lib-99'))).toBe(false);
    const out = s.lines.join('\n');
    expect(out).toContain('real-lib-12: 4 file(s) written, 2 PRD document(s)');
    expect(out).toMatch(/real-lib-99: FAILED/);
    expect(out).toMatch(new RegExp(`GitHub API calls \\(GET\\): ${gh.calls.length}$`));
    expect(out).not.toContain('secret-token-value');
    expect(gh.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('M3.5 --ids limits the run and rejects unknown ids', async () => {
    const s = setup([source]);
    const deps = {
      env: { GITHUB_TOKEN: 't' },
      print: s.print,
      root: join(s.dir, 'real'),
      sourcesPath: s.sourcesPath,
    };
    expect(await main(['--ids', 'real-nope-1'], deps)).toBe(2);
    expect(s.lines.at(-1)).toContain('Unknown id(s): real-nope-1');
    expect(await main(['--ids', 'real-lib-12'], { ...deps, fetch: fakeGitHub().fetch as typeof fetch })).toBe(
      0,
    );
  });
});
