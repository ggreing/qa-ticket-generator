/** CLI entry point: `qa-ticket-generator run --repo o/r --pr 12`. OWNERSHIP: control session. */
import { writeFile } from 'node:fs/promises';
import { getOctokit } from '@actions/github';
import type { Logger } from '../core/contracts';
import { toQtgError } from '../core/errors';
import { CliUsageError, cliInputReader, parseArgs, USAGE } from './cli-args';
import { execute } from './wire';

declare const __QTG_VERSION__: string | undefined;

const err = (line: string) => process.stderr.write(`${line}\n`);

// Logs go to stderr so stdout carries only the report.
const logger: Logger = {
  debug: (m) => {
    if (process.env.QTG_DEBUG) err(`debug: ${m}`);
  },
  info: (m) => err(m),
  warn: (m) => err(`warning: ${m}`),
  error: (m) => err(`error: ${m}`),
  group: async (name, fn) => {
    err(`▸ ${name}`);
    return fn();
  },
};

export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliUsageError) {
      err(`error: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write(`${typeof __QTG_VERSION__ === 'string' ? __QTG_VERSION__ : 'dev'}\n`);
    return 0;
  }

  const input = cliInputReader(args, process.env);
  const token = input('github-token');
  if (!token) {
    err('error: GITHUB_TOKEN is required.');
    return 2;
  }
  const { owner, repo } = args.repo as NonNullable<typeof args.repo>;
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());

  try {
    const result = await execute({
      input,
      event: { name: 'workflow_dispatch', dispatchPrNumber: args.pr as number },
      owner,
      repo,
      octokit: getOctokit(token),
      logger,
      signal: controller.signal,
      bypassGate: true,
      fullReportUrl: (final) => final.pr.htmlUrl,
      sink: {
        async writeMarkdown(markdown) {
          if (args.format === 'md') process.stdout.write(`${markdown}\n`);
        },
        async writeJson(json) {
          if (args.format === 'json') process.stdout.write(json);
          if (!args.out) return null;
          await writeFile(args.out, json, 'utf8');
          return args.out;
        },
      },
    });
    if (result.kind === 'skipped') return 0;
    const { final, failed } = result.outcome;
    if (final.status === 'error') err(`error: ${final.error?.message ?? 'unknown error'}`);
    return failed || final.status === 'error' ? 1 : 0;
  } catch (e) {
    const q = toQtgError(e);
    err(`error: ${q.code}: ${q.userMessage}`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    err(`fatal: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
