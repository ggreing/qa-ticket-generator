#!/usr/bin/env node
/**
 * Launcher for the eval tools. The sources are TypeScript, so this bundles evals/main.ts with
 * esbuild (already a dev dependency) into evals/.build/ and runs the result.
 *
 *   node evals/cli.mjs run --effort high,medium          # prints the plan and estimated cost only
 *   node evals/cli.mjs run --effort high,medium --yes    # calls the API (needs ANTHROPIC_API_KEY)
 *   node evals/cli.mjs build-cases                       # regenerates evals/cases and evals/splits.json
 *   node evals/cli.mjs snapshot-real [--ids a,b]         # fetches the real-PR snapshots (needs GITHUB_TOKEN)
 */
import { execFileSync } from 'node:child_process';
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

if (process.argv[2] === 'build-cases') {
  // Keep the generated JSON in the repository's formatting so `npm run lint` stays clean.
  const biome = join(here, '..', 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
  execFileSync(
    process.execPath,
    [biome, 'format', '--write', join(here, 'cases'), join(here, 'splits.json')],
    {
      stdio: 'inherit',
    },
  );
}
