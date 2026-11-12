/** Entry point bundled and started by evals/cli.mjs. Run from the repository root. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { createPreprocessEngine } from '../src/preprocess';
import { createJudgeClient } from './judge';
import { runEvals } from './run';
import { writeCases } from './tools/build-cases';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'build-cases') {
    const written = writeCases(resolve('evals/cases'));
    console.log(`Wrote ${written.length} case(s): ${written.join(', ')}`);
    return 0;
  }
  if (command !== 'run') {
    console.log('Usage: node evals/cli.mjs run [options]   |   node evals/cli.mjs build-cases');
    return command === undefined || command === '--help' ? 0 : 2;
  }
  const outcome = await runEvals(rest, {
    casesRoot: resolve('evals/cases'),
    resultsRoot: resolve('evals/results'),
    env: process.env,
    print: (line) => console.log(line),
    now: () => Date.now(),
    createEngine: createPreprocessEngine,
    createProvider: ({ apiKey, model, effort, maxOutputTokens }) =>
      createAnthropicProvider(
        { apiKey, model, effort, serverFallback: false, maxOutputTokens },
        { logger: { warn: (message) => console.warn(message) } },
      ),
    createJudgeClient,
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
  });
  return outcome.exitCode;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
