/** Guards .github/workflows/release.yml and docs/RELEASE.md. Owner: qa-work-session-a. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: string;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const RAW = read('.github/workflows/release.yml');
const wf = parse(RAW) as Workflow;
const jobs = Object.entries(wf.jobs);
const allSteps = jobs.flatMap(([, j]) => j.steps);
const runs = allSteps.map((s) => s.run ?? '').join('\n');
const needs = (j: Job | undefined) => [j?.needs ?? []].flat();
/** YAML with comments removed, for "is X referenced" checks. */
const code = RAW.split('\n')
  .map((l) => l.replace(/(^|\s)#.*$/, ''))
  .join('\n');

describe('release.yml', () => {
  it('REL triggers only on vX.Y.Z tag pushes', () => {
    expect(wf.on).toEqual({ push: { tags: ['v*.*.*'] } });
  });

  it('REL grants no default permissions and the minimum per job', () => {
    expect(wf.permissions).toEqual({});
    const allowed: Record<string, Record<string, string>> = {
      verify: { contents: 'read' },
      npm: { contents: 'read', 'id-token': 'write' },
      'github-release': { contents: 'write' },
    };
    expect(Object.keys(wf.jobs).sort()).toEqual(Object.keys(allowed).sort());
    for (const [name, job] of jobs) expect(job.permissions, name).toEqual(allowed[name]);
    expect(code).not.toMatch(/write-all|read-all/);
  });

  it('REL runs only in the upstream repository, in order verify → npm → github-release', () => {
    for (const [name, job] of jobs)
      expect(job.if, name).toContain("github.repository == 'ggreing/qa-ticket-generator'");
    expect(needs(wf.jobs.npm)).toEqual(['verify']);
    expect(needs(wf.jobs['github-release']).sort()).toEqual(['npm', 'verify']);
  });

  it('REL npm is opt-in (NPM_PUBLISH) and a skipped npm job still releases the Action', () => {
    expect(wf.jobs.npm?.if).toContain("vars.NPM_PUBLISH == 'true'");
    const gate = wf.jobs['github-release']?.if ?? '';
    expect(gate).toContain("needs.verify.result == 'success'");
    expect(gate).toContain("needs.npm.result == 'skipped'");
    expect(gate).toContain('!cancelled()');
  });

  it('REL verify installs, checks and builds, then compares dist/', () => {
    const verify = (wf.jobs.verify?.steps ?? []).map((s) => s.run?.trim() ?? '');
    const at = (cmd: string) => verify.indexOf(cmd);
    expect(at('npm ci')).toBeGreaterThanOrEqual(0);
    expect(at('npm run check')).toBeGreaterThan(at('npm ci'));
    expect(at('npm run build')).toBeGreaterThan(at('npm run check'));
    const compare = verify.findIndex((r) => r.includes('git diff --exit-code') && r.includes('dist/'));
    expect(compare).toBeGreaterThan(at('npm run build'));
  });

  it('REL publishes to npm with provenance via OIDC, not a stored token', () => {
    const publish = (wf.jobs.npm?.steps ?? []).find((s) => s.run?.includes('npm publish'));
    expect(publish?.run).toMatch(/npm publish --provenance --access public/);
    expect(wf.jobs.npm?.environment).toBe('release');
    expect(code).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it('REL creates the GitHub Release with generated notes and moves the major tag', () => {
    expect(runs).toMatch(/gh release create "\$GITHUB_REF_NAME"/);
    expect(runs).toContain('--generate-notes');
    expect(runs).toContain('--verify-tag');
    const move = (wf.jobs['github-release']?.steps ?? []).find((s) => s.name === 'Move the major tag');
    expect(move?.if).toContain("prerelease != 'true'");
    expect(move?.run).toContain('-F force=true');
  });

  it('REL pins every action to a commit SHA with a version comment, or marks it TODO(pin)', () => {
    const usesLines = RAW.split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      const pinned = /@[0-9a-f]{40}\s+#\s*v\d/.test(line);
      expect(pinned || line.includes('TODO(pin)'), line.trim()).toBe(true);
    }
  });

  it('REL never interpolates GitHub expressions inside run scripts', () => {
    for (const step of allSteps) expect(step.run ?? '', step.name).not.toContain('${{');
  });

  it('REL checkouts do not persist credentials', () => {
    const checkouts = allSteps.filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const s of checkouts) expect(s.with?.['persist-credentials']).toBe(false);
  });
});

describe('docs/RELEASE.md', () => {
  const md = read('docs/RELEASE.md');

  it('REL documents the chosen approach and its alternatives', () => {
    expect(md).toContain('A. Release commit + tag (chosen)');
    for (const alt of ['B. Tag `main`', 'C. Commit `dist/` to `main`', 'D. `workflow_dispatch`'])
      expect(md).toContain(alt);
    expect(md).toMatch(/Alternative: npm token instead of trusted publishing/);
  });

  it('REL M4 checklist covers every requested item', () => {
    const checklist = md.slice(md.indexOf('## M4 publication checklist'));
    for (const item of [
      'gitleaks',
      'Private vulnerability reporting',
      'Branch protection',
      'Marketplace',
      'branding',
      'npm view qa-ticket-generator',
      'trusted publisher',
      'needs-ai-qa',
      'updates the same comment',
      'no_logic_change',
      'fork_pr',
      'bot mode',
      'Webhook mode',
      'warning icon',
      'prd_permission',
      'cost_cap',
      'zh-CN',
      'badges',
      '_(in progress)_',
      'TODO(pin)',
      'D-17',
    ]) {
      expect(checklist, item).toContain(item);
    }
    expect((checklist.match(/^\s*- \[ \]/gm) ?? []).length).toBeGreaterThanOrEqual(25);
  });

  it('REL relative links exist and there are no e-mail addresses', () => {
    const base = new URL('docs/RELEASE.md', ROOT);
    const links = [...md.replace(/```[\s\S]*?```/g, '').matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1] ?? '')
      .filter((l) => !/^[a-z]+:/i.test(l) && !l.startsWith('#'));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(existsSync(new URL(l, base)), l).toBe(true);
    expect(md).not.toMatch(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i);
  });
});

// ─── Executes the workflow's own shell steps against a throw-away git repository ───
// Uses bash like GitHub's runners (`bash --noprofile --norc -eo pipefail`). Skipped on Windows unless
// QTG_TEST_BASH points at a bash binary (e.g. Git Bash), because `bash` there may resolve to WSL.
const BASH = process.env.QTG_TEST_BASH ?? (process.platform === 'win32' ? '' : 'bash');
const canRun = BASH !== '' && spawnSync(BASH, ['-c', 'git --version && node --version']).status === 0;

describe.skipIf(!canRun)('release.yml shell steps', () => {
  const verify = wf.jobs.verify?.steps ?? [];
  const script = (name: string) => {
    const s = verify.find((x) => x.name === name)?.run;
    expect(s, name).toBeDefined();
    return s as string;
  };
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** main commit (source) + release commit adding `releaseFiles`; origin/main points at the source commit. */
  function repo(
    version: string,
    releaseFiles: Record<string, string>,
    opts: { parentOnMain?: boolean } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'qtg-release-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'ci@invalid');
    git(dir, 'config', 'user.name', 'ci');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export {};\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'source');
    const source = git(dir, 'rev-parse', 'HEAD');
    if (opts.parentOnMain === false) {
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const unreviewed = 1;\n');
      git(dir, 'commit', '-q', '-am', 'not on main');
    }
    git(dir, 'update-ref', 'refs/remotes/origin/main', source);
    for (const [path, body] of Object.entries(releaseFiles)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    git(dir, 'add', '--all');
    git(dir, 'commit', '-q', '-m', 'release');
    return dir;
  }

  function run(dir: string, body: string, env: Record<string, string>) {
    const output = join(dir, '.gh-output');
    writeFileSync(output, '');
    const r = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', body], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output, ...env },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(/=(.*)/s, 2) as [string, string]),
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}`, outputs };
  }

  const dist = { 'dist/action.js': 'a', 'dist/cli.js': 'c' };

  it('REL "Read tag" parses stable and pre-release tags and rejects others', () => {
    const dir = repo('1.2.3', dist);
    const head = git(dir, 'rev-parse', 'HEAD');
    const stable = run(dir, script('Read tag'), { GITHUB_REF_NAME: 'v1.2.3' });
    expect(stable.status).toBe(0);
    expect(stable.outputs).toEqual({ version: '1.2.3', major: 'v1', prerelease: 'false', commit: head });
    const rc = run(dir, script('Read tag'), { GITHUB_REF_NAME: 'v0.2.0-rc.1' });
    expect(rc.outputs).toMatchObject({ version: '0.2.0-rc.1', major: 'v0', prerelease: 'true' });
    for (const bad of ['v1.2', '1.2.3', 'v1.2.3.4', 'v1.2.3-$(id)']) {
      expect(run(dir, script('Read tag'), { GITHUB_REF_NAME: bad }).status, bad).not.toBe(0);
    }
  });

  it('REL "Tag matches package.json version" compares the tag with package.json', () => {
    const dir = repo('0.1.0', dist);
    expect(run(dir, script('Tag matches package.json version'), { VERSION: '0.1.0' }).status).toBe(0);
    const mismatch = run(dir, script('Tag matches package.json version'), { VERSION: '0.1.1' });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.out).toContain('package.json version is 0.1.0');
  });

  it('REL accepts a release commit that only adds dist/ on top of main', () => {
    const dir = repo('0.1.0', dist);
    const r = run(dir, script('Release commit only adds dist/ on top of a main commit'), {});
    expect(r.status, r.out).toBe(0);
  });

  it('REL rejects release commits touching other files, missing dist/, or not based on main', () => {
    const step = script('Release commit only adds dist/ on top of a main commit');
    const extra = run(repo('0.1.0', { ...dist, 'src/a.ts': 'export const sneaky = 1;\n' }), step, {});
    expect(extra.status).not.toBe(0);
    expect(extra.out).toContain('src/a.ts');
    expect(run(repo('0.1.0', { 'dist/action.js': 'a' }), step, {}).status).not.toBe(0);
    const offMain = run(repo('0.1.0', dist, { parentOnMain: false }), step, {});
    expect(offMain.status).not.toBe(0);
    expect(offMain.out).toContain('not on main');
  });
});
