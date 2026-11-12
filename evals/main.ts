/** Entry point bundled and started by evals/cli.mjs. Run from the repository root. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { createPreprocessEngine } from '../src/preprocess';
import { createJudgeClient } from './judge';
import { createRubricClient } from './rubric';
import { runEvals } from './run';
import { writeCases } from './tools/build-cases';
import { main as snapshotReal } from './tools/snapshot-real';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'build-cases') {
    const written = writeCases(resolve('evals/cases'));
    console.log(`Wrote ${written.length} case(s): ${written.join(', ')}`);
    return 0;
  }
  if (command === 'snapshot-real') {
    // Fetches the real-PR snapshots listed in evals/real-sources.json (GET only, needs GITHUB_TOKEN).
    return snapshotReal(rest, {
      env: process.env,
      print: (line) => console.log(line),
      root: resolve('evals/real'),
      sourcesPath: resolve('evals/real-sources.json'),
    });
  }
  if (command !== 'run') {
    console.log('Usage: node evals/cli.mjs run [options]   |   build-cases   |   snapshot-real [--ids a,b]');
    return command === undefined || command === '--help' ? 0 : 2;
  }
  const outcome = await runEvals(rest, {
    evalsRoot: resolve('evals'),
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
    createRubricClient,
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    readFile: (path) => readFileSync(path, 'utf8'),
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
