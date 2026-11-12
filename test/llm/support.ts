/** Test doubles for the LLM layer (no network). */
import type {
  CodeChunk,
  GenerateRequest,
  LlmProvider,
  LlmResult,
  LlmUsage,
  MergeRequest,
  PrdDocument,
  PreprocessOutput,
  PromptContext,
  QaReport,
} from '../../src/core/contracts';
import type { AnthropicClientLike, LlmMessage, LlmStream } from '../../src/llm/anthropic';
import { estimateCostUsd } from '../../src/llm/pricing';
import { fakeReport } from '../helpers/fakes';

export function prdDoc(id = 'PROJ-123', body = 'Coupons can be applied once.'): PrdDocument {
  return {
    ref: { source: 'jira', id, raw: id, url: `https://acme.atlassian.net/browse/${id}` },
    title: 'Coupon at checkout',
    bodyMarkdown: body,
    acceptanceCriteria: ['AC1: a coupon can be applied once', 'AC3: expired coupons are rejected'],
    url: `https://acme.atlassian.net/browse/${id}`,
    meta: {},
  };
}

export function promptContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    pr: {
      number: 42,
      title: 'Apply coupon at checkout',
      body: 'Implements PROJ-123.',
      htmlUrl: 'https://github.com/acme/shop/pull/42',
      author: 'dev',
      baseRef: 'main',
      headRef: 'feat/coupon',
    },
    prdDocuments: [prdDoc()],
    language: 'en',
    maxScenarios: 20,
    ...overrides,
  };
}

export function chunk(id: string, paths: string[], estimatedTokens = 10_000): CodeChunk {
  return {
    id,
    estimatedTokens,
    files: paths.map((path) => ({
      path,
      status: 'modified' as const,
      score: 1,
      hunks: [
        {
          header: '@@ -1,2 +1,3 @@',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          text: ` const a = 1;\n+apply(coupon); // ${path}`,
        },
      ],
      contexts: [
        { kind: 'symbol' as const, name: 'apply', startLine: 1, endLine: 9, text: 'function apply() {}' },
      ],
      estimatedTokens,
    })),
  };
}

export function preOutput(chunks: CodeChunk[], overrides: Partial<PreprocessOutput> = {}): PreprocessOutput {
  return {
    mode: chunks.length > 1 ? 'map_reduce' : 'single',
    chunks,
    prdDocuments: [prdDoc()],
    skipped: [{ path: 'package-lock.json', reason: 'noise' }],
    redactions: [],
    estimatedTokens: chunks.reduce((n, c) => n + c.estimatedTokens, 0),
    ...overrides,
  };
}

export const usage = (inputTokens: number, outputTokens: number): LlmUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

type GenerateImpl = (
  req: GenerateRequest,
  signal: AbortSignal,
) => Promise<LlmResult<QaReport>> | LlmResult<QaReport>;
type MergeImpl = (
  req: MergeRequest,
  signal: AbortSignal,
) => Promise<LlmResult<QaReport>> | LlmResult<QaReport>;

export const result = (value: QaReport, u: LlmUsage = usage(1_000, 500)): LlmResult<QaReport> => ({
  value,
  usage: u,
  model: 'claude-opus-5-5',
  stopReason: 'end_turn',
});

/** LlmProvider double that records requests; cost uses the real Opus 5.5 price table. */
export function fakeProvider(generate?: GenerateImpl, merge?: MergeImpl) {
  const generateCalls: GenerateRequest[] = [];
  const mergeCalls: MergeRequest[] = [];
  const provider: LlmProvider = {
    id: 'fake',
    async generateReport(req, signal) {
      generateCalls.push(req);
      return generate ? generate(req, signal) : result(fakeReport({ summary: `part ${req.chunk.id}` }));
    },
    async mergeReports(req, signal) {
      mergeCalls.push(req);
      return merge ? merge(req, signal) : result(fakeReport({ summary: 'merged' }));
    },
    estimateCostUsd: (u) => estimateCostUsd('claude-opus-5-5', u),
  };
  return { provider, generateCalls, mergeCalls };
}

export function message(report: unknown = fakeReport(), overrides: Partial<LlmMessage> = {}): LlmMessage {
  return {
    content: [
      { type: 'thinking' },
      { type: 'text', text: typeof report === 'string' ? report : JSON.stringify(report) },
    ],
    stop_reason: 'end_turn',
    model: 'claude-opus-5-5',
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 300,
    },
    ...overrides,
  };
}

export interface RecordedCall {
  endpoint: 'stable' | 'beta';
  // biome-ignore lint/suspicious/noExplicitAny: request bodies are inspected loosely in tests.
  body: any;
  signal?: AbortSignal;
}

/** Scripted Anthropic client: each stream() call consumes the next step (a message or an error). */
export function fakeClient(steps: Array<LlmMessage | Error>) {
  const calls: RecordedCall[] = [];
  const open =
    (endpoint: RecordedCall['endpoint']) => (body: unknown, options?: { signal?: AbortSignal }) => {
      calls.push({ endpoint, body, signal: options?.signal });
      const step = steps.shift();
      const listeners: Array<() => void> = [];
      const stream: LlmStream = {
        on(_event, listener) {
          listeners.push(listener);
          return stream;
        },
        async finalMessage() {
          for (const l of listeners) l();
          if (!step) throw new Error('fakeClient: no scripted response left');
          if (step instanceof Error) throw step;
          return step;
        },
      };
      return stream;
    };
  const client: AnthropicClientLike = {
    messages: { stream: open('stable') },
    beta: { messages: { stream: open('beta') } },
  };
  return { client, calls };
}
