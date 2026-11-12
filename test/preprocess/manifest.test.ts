import { describe, expect, it } from 'vitest';
import type { Hunk } from '../../src/core/contracts';
import { parsePatch } from '../../src/preprocess/diff';
import { MAX_OTHER_LINES, manifestKind, summarizeManifest } from '../../src/preprocess/manifest';
import { hunk } from './helpers';

const hunks = (...bodies: string[][]): Hunk[] => bodies.flatMap((b) => parsePatch(hunk(1, 1, b)).hunks);

describe('PRE-03 manifest detection', () => {
  it.each([
    ['package.json', 'npm'],
    ['apps/web/package.json', 'npm'],
    ['composer.json', 'composer'],
    ['go.mod', 'go'],
    ['pyproject.toml', 'pyproject'],
    ['Cargo.toml', 'cargo'],
    ['Pipfile', 'pipfile'],
    ['Gemfile', 'gemfile'],
    ['requirements.txt', 'pip'],
    ['requirements-dev.txt', 'pip'],
    ['dev-requirements.txt', 'pip'],
    ['constraints.txt', 'pip'],
    ['requirements/base.txt', 'pip'],
  ])('PRE-03 %s is a %s manifest', (path, kind) => {
    expect(manifestKind(path)).toBe(kind);
  });

  it.each(['package-lock.json', 'src/package.ts', 'notes.txt', 'go.sum'])(
    'PRE-03 %s is not a manifest',
    (path) => {
      expect(manifestKind(path)).toBeNull();
    },
  );
});

describe('PRE-03 manifest summaries', () => {
  it('PRE-03 npm: sections from context, unknown sections by version shape, top-level keys are "other"', () => {
    const s = summarizeManifest(
      'npm',
      'package.json',
      hunks(
        [
          '   "peerDependencies": {',
          '+    "react": ">=18"',
          '   },',
          '   "optionalDependencies": {',
          '+    "fsevents": "^2"',
        ],
        [
          '+    "left-pad": "^1.3.0",',
          '-  "version": "1.0.0",',
          '+  "version": "1.1.0",',
          '+  "license": "MIT"',
        ],
      ),
    );
    expect(s).toBe(
      'added: fsevents@^2 (optional), left-pad@^1.3.0, react@>=18 (peer); other: -"version": "1.0.0", | +"version": "1.1.0", | +"license": "MIT"',
    );
  });

  it('PRE-03 composer: require / require-dev', () => {
    const s = summarizeManifest(
      'composer',
      'composer.json',
      hunks([
        '   "require": {',
        '-    "monolog/monolog": "^2.0",',
        '+    "monolog/monolog": "^3.0"',
        '   },',
        '   "require-dev": {',
        '+    "phpunit/phpunit": "^11"',
      ]),
    );
    expect(s).toBe('added: phpunit/phpunit@^11 (dev); changed: monolog/monolog ^2.0 -> ^3.0');
  });

  it('PRE-03 a moved dependency with the same version is not reported', () => {
    expect(
      summarizeManifest(
        'npm',
        'package.json',
        hunks(['   "dependencies": {', '-    "a": "^1"', '+    "a": "^1"']),
      ),
    ).toBe('no dependency changes');
  });

  it('PRE-03 "other" lines are capped and long lines truncated', () => {
    const body = Array.from(
      { length: MAX_OTHER_LINES + 3 },
      (_, i) => `+  "script${i}": "${'x'.repeat(200)}"`,
    );
    const s = summarizeManifest('npm', 'package.json', hunks(['   "scripts": {', ...body]));
    expect(s).toMatch(/\(\+3 more\)$/);
    expect(s).toContain('...');
  });

  it('PRE-03 go.mod: replace blocks are "other", unknown context still finds requirements', () => {
    const s = summarizeManifest(
      'go',
      'go.mod',
      hunks([
        ' replace (',
        '+\tgithub.com/a/b => ../b',
        ' )',
        '+\tgithub.com/c/d v1.2.3',
        '-toolchain go1.22.0',
      ]),
    );
    expect(s).toBe('added: github.com/c/d@v1.2.3; other: +github.com/a/b => ../b | -toolchain go1.22.0');
  });

  it('PRE-03 requirements: comments are ignored, extras and markers parsed', () => {
    const s = summarizeManifest(
      'pip',
      'requirements.txt',
      hunks([
        '+# pinned',
        '+uvicorn[standard]>=0.30 ; python_version >= "3.10"',
        '+Django_Filter == 24.2',
        '+',
        '+--index-url https://x',
      ]),
    );
    expect(s).toBe('added: Django_Filter==24.2, uvicorn[standard]>=0.30; other: +--index-url https://x');
  });

  it('PRE-03 pyproject: single-line arrays, optional deps, dependency groups and build requires', () => {
    const s = summarizeManifest(
      'pyproject',
      'pyproject.toml',
      hunks(
        ['+[build-system]', '+requires = ["hatchling>=1.24"]'],
        [
          ' [project.optional-dependencies]',
          '+docs = ["mkdocs>=1.6"]',
          ' [dependency-groups]',
          '+lint = [',
          '+  "ruff>=0.5",',
          '+]',
        ],
        [
          ' [tool.poetry.dev-dependencies]',
          '+black = "^24.0"',
          ' [tool.poetry.dependencies]',
          '+python = "^3.12"',
          '+stripe = { git = "https://x" }',
        ],
      ),
    );
    expect(s).toBe(
      'added: black@^24.0 (dev), hatchling>=1.24 (build), mkdocs>=1.6 (optional), python@^3.12, ruff>=0.5 (lint), stripe@git',
    );
  });

  it('PRE-03 pyproject: metadata keys in an unknown section are "other"', () => {
    expect(
      summarizeManifest('pyproject', 'pyproject.toml', hunks(['-version = "1.0"', '+version = "1.1"'])),
    ).toBe('other: -version = "1.0" | +version = "1.1"');
  });

  it('PRE-03 cargo: path / workspace dependencies and target tables', () => {
    const s = summarizeManifest(
      'cargo',
      'Cargo.toml',
      hunks([
        " [target.'cfg(unix)'.dependencies]",
        '+nix = "0.29"',
        ' [build-dependencies]',
        '+cc = { path = "../cc" }',
        ' [workspace.dependencies]',
        '+anyhow = { workspace = true }',
        '+log = { features = ["std"] }',
      ]),
    );
    expect(s).toBe('added: anyhow@workspace, cc@path (build), log, nix@0.29');
  });

  it('PRE-03 Gemfile: groups mark dev gems and reset at end', () => {
    const s = summarizeManifest(
      'gemfile',
      'Gemfile',
      hunks([
        ' group :production do',
        "+  gem 'pg'",
        ' end',
        ' group :test do',
        "+  gem 'rspec'",
        ' end',
        "+ruby '3.3.0'",
      ]),
    );
    expect(s).toBe("added: pg, rspec (dev); other: +ruby '3.3.0'");
  });
});
