/** CLI argument parsing and input mapping (pure, testable). OWNERSHIP: control session. */
import type { InputReader } from '../core/config';

export const USAGE = `Usage:
  qa-ticket-generator plan --repo <owner/repo> --spec <ref> [options]
  qa-ticket-generator run  --repo <owner/repo> --pr <number> [options]

plan reads a spec (issue number, Jira key or Notion URL) and writes one QA case per test idea.
Dry-run by default: cases go to qa-cases.{md,csv,json} in --out-dir and nothing else is touched.
Pass --publish to create or update tickets in the configured --sinks.

run checks a pull request.

Generates BDD QA scenarios for a pull request. Dry-run by default: the report is printed and
nothing is published. Pass --publish to write the PR comment and Slack message.

Options:
  --repo <owner/repo>     Repository (required)
  --spec <ref>            Spec to plan from (plan)
  --sinks <list>          jira,github-issue,notion,file (plan, with --publish)
  --out-dir <path>        Where qa-cases.* files go (plan, default: .)
  --max-cases <n>         Safety cap on cases per spec (plan, default: 80)
  --pr <number>           Pull request number (run)
  --publish               Publish to the PR comment / Slack instead of dry-run
  --format <md|json>      Stdout format (default: md)
  --out <path>            Also write report.json to this path
  --language <code>       en | ko | ja | zh-CN (aliases: kr, jp, cn, zh)
  --model <id>            Claude model id (default: claude-opus-5-5)
  --effort <level>        low | medium | high | xhigh | max (default: high)
  --max-cost-usd <n>      Cost ceiling per run (default: 2.00)
  --config-path <path>    Repo config path (default: .github/qa-ticket-generator.yml)
  -h, --help              Show this help
  -v, --version           Show the version

Environment:
  GITHUB_TOKEN, ANTHROPIC_API_KEY (required)
  SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_WEBHOOK_URL, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
  JIRA_PROJECT_KEYS, NOTION_TOKEN (optional). Any action input can be set as its upper-case
  env name, e.g. MAX_SCENARIOS=10.
`;

export interface CliArgs {
  command: 'run' | 'plan' | 'help' | 'version';
  repo?: { owner: string; repo: string };
  pr?: number;
  publish: boolean;
  format: 'md' | 'json';
  out?: string;
  /** plan: directory for qa-cases.* files. */
  outDir?: string;
  /** Flags that map 1:1 to action inputs. */
  inputs: Record<string, string>;
}

export class CliUsageError extends Error {}

const INPUT_FLAGS = new Set([
  'language',
  'model',
  'effort',
  'max-cost-usd',
  'config-path',
  'spec',
  'sinks',
  'max-cases',
]);

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: 'help', publish: false, format: 'md', inputs: {} };
  const rest = [...argv];
  const first = rest[0];
  if (first === undefined || first === '-h' || first === '--help' || first === 'help') return args;
  if (first === '-v' || first === '--version') return { ...args, command: 'version' };
  if (first !== 'run' && first !== 'plan') throw new CliUsageError(`Unknown command "${first}".`);
  rest.shift();
  args.command = first;

  while (rest.length > 0) {
    const flag = rest.shift() as string;
    if (flag === '-h' || flag === '--help') return { ...args, command: 'help' };
    if (flag === '--publish') {
      args.publish = true;
      continue;
    }
    const [name, inline] = flag.startsWith('--') ? flag.slice(2).split(/=(.*)/s, 2) : [flag, undefined];
    const value = inline ?? rest.shift();
    if (value === undefined || value.startsWith('--')) throw new CliUsageError(`Missing value for ${flag}.`);
    switch (name) {
      case 'repo': {
        const m = /^([\w.-]+)\/([\w.-]+)$/.exec(value);
        if (!m?.[1] || !m[2]) throw new CliUsageError('--repo must look like owner/repo.');
        args.repo = { owner: m[1], repo: m[2] };
        break;
      }
      case 'pr': {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) throw new CliUsageError('--pr must be a positive integer.');
        args.pr = n;
        break;
      }
      case 'format':
        if (value !== 'md' && value !== 'json') throw new CliUsageError('--format must be md or json.');
        args.format = value;
        break;
      case 'out':
        args.out = value;
        break;
      case 'out-dir':
        args.outDir = value;
        break;
      default:
        if (name && INPUT_FLAGS.has(name)) args.inputs[name] = value;
        else throw new CliUsageError(`Unknown option ${flag}.`);
    }
  }
  if (!args.repo) throw new CliUsageError('--repo is required.');
  if (args.command === 'run' && !args.pr) throw new CliUsageError('--pr is required.');
  if (args.command === 'plan' && !args.inputs.spec) throw new CliUsageError('--spec is required.');
  if (args.command === 'plan') args.inputs.mode = 'plan';
  return args;
}

/** Maps action input names to flags, then to env vars (`max-scenarios` → `MAX_SCENARIOS`). */
export function cliInputReader(args: CliArgs, env: NodeJS.ProcessEnv): InputReader {
  return (name) => {
    if (name === 'dry-run') return args.publish ? 'false' : 'true';
    const flag = args.inputs[name];
    if (flag !== undefined) return flag;
    return env[name.toUpperCase().replace(/-/g, '_')] ?? '';
  };
}
