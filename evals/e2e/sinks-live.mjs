#!/usr/bin/env node
/**
 * Launcher for the Jira / Notion live check (evals/e2e/live-check.ts). It bundles the TypeScript
 * with esbuild (a dev dependency) into evals/.build/ and runs it.
 *
 *   node evals/e2e/sinks-live.mjs                       # dry run: plan and variables, sends nothing
 *   node evals/e2e/sinks-live.mjs --yes                 # writes real tickets
 *   node evals/e2e/sinks-live.mjs --yes --only jira     # one target
 *   node evals/e2e/sinks-live.mjs --yes --cleanup       # close (Jira) / trash (Notion) them afterwards
 *
 * Jira:   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT
 *         optional JIRA_STORY (use this story), JIRA_STORY_TYPE (default Story), JIRA_SUBTASK_TYPE
 * Notion: NOTION_TOKEN, NOTION_QA_DATABASE_ID
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, '..', '.build', 'live-check.mjs');

await build({
  entryPoints: [join(here, 'live-check.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  logLevel: 'warning',
});
const { parseArgs, runLiveCheck } = await import(pathToFileURL(outfile).href);
const { exitCode } = await runLiveCheck({ ...parseArgs(process.argv.slice(2)), env: process.env });
process.exitCode = exitCode;
