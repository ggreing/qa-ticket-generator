#!/usr/bin/env node
/**
 * Launcher for the eval tools. The sources are TypeScript, so this bundles evals/main.ts with
 * esbuild (already a dev dependency) into evals/.build/ and runs the result.
 *
 *   node evals/cli.mjs run --effort high,medium          # prints the plan and estimated cost only
 *   node evals/cli.mjs run --effort high,medium --yes    # calls the API (needs ANTHROPIC_API_KEY)
 *   node evals/cli.mjs build-cases                       # regenerates evals/cases, splits.json and CASES.md
 *   node evals/cli.mjs snapshot-real [--ids a,b]         # fetches the real-PR snapshots (needs GITHUB_TOKEN)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, '.build', 'main.mjs');

await build({
  entryPoints: [join(here, 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  logLevel: 'warning',
});
await import(pathToFileURL(outfile).href);

// Keep generated files in the repository's formatting so `npm run lint` stays clean.
const biome = join(here, '..', 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const format = (paths) => {
  const present = paths.filter((path) => existsSync(path));
  if (present.length > 0) {
    execFileSync(process.execPath, [biome, 'format', '--write', ...present], { stdio: 'inherit' });
  }
};

if (process.argv[2] === 'build-cases') {
  format([join(here, 'cases'), join(here, 'splits.json'), join(here, 'CASES.md')]);
}

const round = process.argv.indexOf('--round');
if (process.argv[2] === 'plan' && round > 0) {
  // v3 plan rounds keep their records apart from the M3.5 ones.
  process.once('beforeExit', () => {
    const dir = join(here, 'rounds', 'v3', String(process.argv[round + 1]));
    const summaries = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
    format([
      join(here, 'ROUNDS.v3.md'),
      join(here, 'rounds', 'v3', 'index.json'),
      ...summaries.map((f) => join(dir, f)),
    ]);
  });
}
if (process.argv[2] === 'run' && round > 0) {
  // The run is still going when the import above returns; format its committed records at the end.
  process.once('beforeExit', () => {
    const dir = join(here, 'rounds', String(process.argv[round + 1]));
    // summary.md, plus summary.rubric-v<n>.md when the round was scored again.
    const summaries = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
    format([
      join(here, 'ROUNDS.md'),
      join(here, 'rounds', 'index.json'),
      ...summaries.map((f) => join(dir, f)),
    ]);
  });
}
