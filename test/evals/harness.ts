/** Runner test doubles: a throwaway evals/ directory, a provider that answers with oracle reports, and in-memory files. */
import { vi } from 'vitest';
import type { JudgeClientLike } from '../../evals/judge';
import { DEFAULT_RUBRIC_MODEL, type RubricClientLike } from '../../evals/rubric';
import type { RunDeps } from '../../evals/run';
import { type EvalCase, type GradedCase, loadDataset } from '../../evals/schema';
import type { GenerateRequest, LlmProvider, QaReport } from '../../src/core/contracts';
import { estimateCostUsd } from '../../src/llm/pricing';
import {
  fakeEngine,
  fakeRubricClient,
  gradedCases,
  makeEvalsRoot,
  oracleReport,
  REAL_DEMO,
  RUBRIC_USAGE,
  type RubricBody,
} from './support';

export const EVALS = makeEvalsRoot();
export const dataset = loadDataset(EVALS).cases;
export const graded = gradedCases();
export const byPr = new Map(dataset.map((c) => [c.pr.number, c]));
export const caseFor = (req: GenerateRequest): EvalCase => byPr.get(req.context.pr.number) as EvalCase;
/** The synthetic case a case's content comes from (itself, or the source of a real-PR stand-in). */
export const sourceOf = (c: EvalCase): GradedCase => {
  const source = (REAL_DEMO as Record<string, { source: string }>)[c.id]?.source ?? c.id;
  return graded.find((g) => g.id === source) as GradedCase;
};
export const inSplit = (split: 'dev' | 'test'): EvalCase[] => dataset.filter((c) => c.split === split);
export const DEV = inSplit('dev');
export const DEV_GRADED = DEV.filter((c) => c.expected !== null);
export const USAGE_PER_CALL = {
  inputTokens: 4_000,
  outputTokens: 6_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
export const RUBRIC_COST = estimateCostUsd(DEFAULT_RUBRIC_MODEL, {
  inputTokens: RUBRIC_USAGE.input_tokens,
  outputTokens: RUBRIC_USAGE.output_tokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Provider double: answers every case with its oracle report unless `respond` says otherwise. */
export function fakeProvider(
  model: string,
  respond?: (c: EvalCase) => QaReport | Error,
  servedModel = model,
): LlmProvider {
  return {
    id: 'fake',
    async generateReport(req) {
      const c = caseFor(req);
      const answer = respond ? respond(c) : oracleReport(sourceOf(c));
      if (answer instanceof Error) throw answer;
      return { value: answer, usage: USAGE_PER_CALL, model: servedModel, stopReason: 'end_turn' };
    },
    async mergeReports() {
      throw new Error('not used: every eval case fits one call');
    },
    estimateCostUsd: (usage) => estimateCostUsd(model, usage),
  };
}

export function harness(overrides: Partial<RunDeps> = {}, respond?: (c: EvalCase) => QaReport | Error) {
  const lines: string[] = [];
  const files: Record<string, string> = {};
  const rubricBodies: RubricBody[] = [];
  const norm = (path: string): string => path.replace(/\\/g, '/').replace(EVALS.replace(/\\/g, '/'), 'evals');
  let clock = Date.UTC(2026, 10, 12, 9, 0, 0);
  const createProvider = vi.fn((request: { model: string }) => fakeProvider(request.model, respond));
  const createJudgeClient = vi.fn(
    (): JudgeClientLike => ({
      messages: {
        parse: async () => ({
          parsed_output: { verdicts: [{ id: 'expired', covered: true, scenarioId: 'TC-01' }] },
          usage: { input_tokens: 3_000, output_tokens: 400 },
        }),
      },
    }),
  );
  const createRubricClient = vi.fn((): RubricClientLike => fakeRubricClient(0, rubricBodies));
  const deps: RunDeps = {
    evalsRoot: EVALS,
    resultsRoot: 'evals/results',
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    print: (line) => void lines.push(line),
    now: () => {
      clock += 1_000;
      return clock;
    },
    createEngine: fakeEngine,
    createProvider,
    createJudgeClient,
    createRubricClient,
    writeFile: (path, text) => {
      files[norm(path)] = text;
    },
    readFile: (path) => {
      const text = files[norm(path)];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    ...overrides,
  };
  return {
    deps,
    lines,
    files,
    rubricBodies,
    createProvider,
    createJudgeClient,
    createRubricClient,
    out: () => lines.join('\n'),
  };
}
