/** GitHub Action entry point. OWNERSHIP: control session. */
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import type { Logger } from '../core/contracts';
import { toQtgError } from '../core/errors';
import { type PayloadLike, toTriggerEvent } from './event';
import { execute, secretInputs } from './wire';

const logger: Logger = {
  debug: (m) => core.debug(m),
  info: (m) => core.info(m),
  warn: (m) => core.warning(m),
  error: (m) => core.error(m),
  group: (name, fn) => core.group(name, fn),
};

export async function main(): Promise<void> {
  const input = (name: string) => core.getInput(name);
  for (const secret of secretInputs(input)) core.setSecret(secret);

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  try {
    const { owner, repo } = context.repo; // throws outside Actions (no GITHUB_REPOSITORY)
    const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
    const result = await execute({
      input,
      event: toTriggerEvent(context.eventName, context.payload as PayloadLike),
      owner,
      repo,
      octokit: getOctokit(input('github-token')),
      logger,
      signal: controller.signal,
      fullReportUrl: () => runUrl,
      sink: {
        async writeMarkdown(markdown) {
          await core.summary.addRaw(markdown, true).write();
        },
        async writeJson(json) {
          const dir = process.env.RUNNER_TEMP || tmpdir();
          await mkdir(dir, { recursive: true });
          const path = join(dir, 'qa-ticket-generator-report.json');
          await writeFile(path, json, 'utf8');
          core.setOutput('report-path', path);
          return path;
        },
      },
    });

    if (result.kind === 'skipped') {
      core.setOutput('skipped-reason', result.reason);
      return;
    }

    const { final, failed } = result.outcome;
    core.setOutput('scenario-count', String(final.report?.scenarios.length ?? 0));
    core.setOutput('alignment-status', final.report?.prdAlignment.status ?? '');
    core.setOutput('cost-usd', final.meta.costUsd.toFixed(4));
    if (final.skipReason) core.setOutput('skipped-reason', final.skipReason);

    if (failed) {
      core.setFailed(
        final.status === 'error'
          ? `QA run failed: ${final.error?.message ?? 'unknown error'}`
          : `PRD alignment is "${final.report?.prdAlignment.status}" (fail-on: ${result.config.failOn}).`,
      );
    } else if (final.status === 'error') {
      core.warning(`QA run did not complete: ${final.error?.message ?? 'unknown error'}`);
    }
  } catch (err) {
    // Errors before the pipeline (invalid inputs/config, PR not found) are configuration problems.
    const e = toQtgError(err);
    core.setFailed(`${e.code}: ${e.userMessage}`);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

void main();
