import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { GenerateRequest } from '../../src/core/contracts';
import { QtgError } from '../../src/core/errors';
import {
  type AnthropicClientLike,
  type AnthropicProviderOptions,
  createAnthropicProvider,
  type LlmMessage,
  type LlmStream,
  SERVER_FALLBACK_BETA,
} from '../../src/llm/anthropic';
import type { StructuredRequest } from '../../src/llm/structured';
import { fakeReport, silentLogger } from '../helpers/fakes';
import { chunk, fakeClient, message, promptContext } from './support';

const OPTIONS: AnthropicProviderOptions = {
  apiKey: 'test-key',
  model: 'claude-opus-5-5',
  effort: 'high',
  serverFallback: false,
  maxOutputTokens: 32_000,
};

const request = (overrides: Partial<GenerateRequest> = {}): GenerateRequest => ({
  context: promptContext(),
  chunk: chunk('c1', ['src/coupon.ts']),
  skipped: [],
  phase: 'single',
  ...overrides,
});

const signal = () => new AbortController().signal;
const headers = new Headers();

async function failure(run: Promise<unknown>): Promise<QtgError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(QtgError);
  return err as QtgError;
}

describe('createAnthropicProvider', () => {
  it('LLM-02 sends the QaReport JSON schema as output_config.format and returns the validated report', async () => {
    const { client, calls } = fakeClient([message()]);
    const provider = createAnthropicProvider(OPTIONS, { client });
    const res = await provider.generateReport(request(), signal());

    expect(res.value).toEqual(fakeReport());
    expect(res.model).toBe('claude-opus-5-5');
    expect(res.stopReason).toBe('end_turn');
    const format = calls[0]?.body.output_config.format;
    expect(format.type).toBe('json_schema');
    expect(Object.keys(format.schema.properties)).toEqual([
      'summary',
      'prdAlignment',
      'scenarios',
      'risks',
      'assumptions',
    ]);
    expect(format).not.toHaveProperty('parse'); // validation runs here, after the stop_reason check
  });

  it('LLM-03 streams with the configured model, effort and a 32K output cap, leaving thinking adaptive', async () => {
    const { client, calls } = fakeClient([message()]);
    await createAnthropicProvider(OPTIONS, { client }).generateReport(request(), signal());
    const body = calls[0]?.body;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(32_000);
    expect(body.output_config.effort).toBe('high');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
  });

  it('LLM-05 uses the beta endpoint with fallbacks "default" when serverFallback is on, and the stable endpoint otherwise', async () => {
    const on = fakeClient([message()]);
    await createAnthropicProvider({ ...OPTIONS, serverFallback: true }, { client: on.client }).generateReport(
      request(),
      signal(),
    );
    expect(on.calls[0]?.endpoint).toBe('beta');
    expect(on.calls[0]?.body.betas).toEqual([SERVER_FALLBACK_BETA]);
    expect(SERVER_FALLBACK_BETA).toBe('server-side-fallback-2026-07-01');
    expect(on.calls[0]?.body.fallbacks).toBe('default');

    const off = fakeClient([message()]);
    await createAnthropicProvider(OPTIONS, { client: off.client }).generateReport(request(), signal());
    expect(off.calls[0]?.endpoint).toBe('stable');
    expect(off.calls[0]?.body).not.toHaveProperty('fallbacks');
    expect(off.calls[0]?.body).not.toHaveProperty('betas');
  });

  it('LLM-06 puts cache_control on the system prompt and the PRD prefix, and keeps that prefix identical across map calls', async () => {
    const { client, calls } = fakeClient([message(), message(), message()]);
    const provider = createAnthropicProvider(OPTIONS, { client });
    await provider.generateReport(request({ phase: 'map', chunk: chunk('c1', ['a.ts']) }), signal());
    await provider.generateReport(request({ phase: 'map', chunk: chunk('c2', ['b.ts']) }), signal());
    await provider.mergeReports(
      { context: promptContext(), partials: [fakeReport(), fakeReport()] },
      signal(),
    );

    const [a, b, merge] = calls.map((c) => c.body);
    expect(a.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    const [prd, meta, tail] = a.messages[0].content;
    expect(prd.text.startsWith('<prd_documents>')).toBe(true);
    expect(prd.cache_control).toEqual({ type: 'ephemeral' });
    expect(meta.text).toContain('<pr_metadata');
    expect(meta.cache_control).toEqual({ type: 'ephemeral' });
    expect(tail).not.toHaveProperty('cache_control');

    expect(b.system).toEqual(a.system);
    expect(b.messages[0].content.slice(0, 2)).toEqual(a.messages[0].content.slice(0, 2));
    expect(b.messages[0].content[2].text).not.toBe(tail.text);
    // The reduce call reuses the same cached prefix and carries reports instead of code.
    expect(merge.messages[0].content.slice(0, 2)).toEqual(a.messages[0].content.slice(0, 2));
    expect(merge.messages[0].content[2].text).toContain('<partial_reports>');
    expect(merge.messages[0].content[2].text).not.toContain('<code_changes>');
  });

  it('LLM-06 holds later map calls until the first one starts streaming, so they can read its cache entry', async () => {
    const started: string[] = [];
    let firstEvent: (() => void) | undefined;
    let finishFirst: ((m: LlmMessage) => void) | undefined;
    const open = (body: { messages: { content: { text: string }[] }[] }): LlmStream => {
      const id = body.messages[0]?.content[2]?.text.includes('a.ts') ? 'first' : 'second';
      started.push(id);
      const stream: LlmStream = {
        on(_event, listener) {
          if (id === 'first') firstEvent = listener;
          return stream;
        },
        finalMessage: () =>
          id === 'first'
            ? new Promise<LlmMessage>((resolve) => (finishFirst = resolve))
            : Promise.resolve(message()),
      };
      return stream;
    };
    const client = {
      messages: { stream: open },
      beta: { messages: { stream: open } },
    } as unknown as AnthropicClientLike;
    const provider = createAnthropicProvider(OPTIONS, { client });

    const first = provider.generateReport(request({ phase: 'map', chunk: chunk('c1', ['a.ts']) }), signal());
    const second = provider.generateReport(request({ phase: 'map', chunk: chunk('c2', ['b.ts']) }), signal());
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['first']);

    firstEvent?.(); // the first response begins streaming → the prefix is now readable
    await second;
    expect(started).toEqual(['first', 'second']);
    finishFirst?.(message());
    await first;
  });

  it('LLM-06 releases waiting map calls when the first one fails', async () => {
    const { client } = fakeClient([
      new Anthropic.InternalServerError(500, undefined, 'boom', headers),
      message(),
    ]);
    const provider = createAnthropicProvider(OPTIONS, { client });
    const first = provider.generateReport(request({ phase: 'map' }), signal());
    const second = provider.generateReport(request({ phase: 'map', chunk: chunk('c2', ['b.ts']) }), signal());
    expect((await failure(first)).code).toBe('llm_unavailable');
    expect((await second).value).toEqual(fakeReport());
  });

  it('LLM-04 turns stop_reason "refusal" into llm_refusal with the category and the billed usage', async () => {
    const { client } = fakeClient([
      message('', { stop_reason: 'refusal', stop_details: { category: 'cyber' } }),
    ]);
    const err = await failure(
      createAnthropicProvider(OPTIONS, { client }).generateReport(request(), signal()),
    );
    expect(err.code).toBe('llm_refusal');
    expect(err.userMessage).toContain('category: cyber');
    expect(err.usage?.outputTokens).toBe(500);
  });

  it('LLM-04 turns stop_reason "max_tokens" into llm_truncated without retrying here', async () => {
    const { client, calls } = fakeClient([message('{"summary": "cut', { stop_reason: 'max_tokens' })]);
    const err = await failure(
      createAnthropicProvider(OPTIONS, { client }).generateReport(request(), signal()),
    );
    expect(err.code).toBe('llm_truncated');
    expect(calls).toHaveLength(1);
  });

  it('LLM-02 retries once when the reply does not match the schema, then succeeds with summed usage', async () => {
    const logger = silentLogger();
    const { client, calls } = fakeClient([message({ summary: 'no other fields' }), message()]);
    const res = await createAnthropicProvider(OPTIONS, { client, logger }).generateReport(
      request(),
      signal(),
    );
    expect(calls).toHaveLength(2);
    expect(res.usage).toEqual({
      inputTokens: 2_000,
      outputTokens: 1_000,
      cacheReadTokens: 400,
      cacheWriteTokens: 600,
    });
    expect(logger.lines.filter((l) => l.startsWith('warn:'))).toHaveLength(1);
  });

  it('LLM-02 fails with llm_schema when the retry is also invalid (bad JSON, empty reply)', async () => {
    const { client, calls } = fakeClient([
      message('not json at all'),
      message('', { content: [{ type: 'thinking' }] }),
    ]);
    const err = await failure(
      createAnthropicProvider(OPTIONS, { client }).generateReport(request(), signal()),
    );
    expect(err.code).toBe('llm_schema');
    expect(calls).toHaveLength(2);
    expect(err.usage?.inputTokens).toBe(2_000);
  });

  it('LLM-08 keeps the usage of a billed first attempt when the schema retry itself fails', async () => {
    const sdkError = new Anthropic.InternalServerError(500, undefined, 'boom', headers);
    const { client } = fakeClient([message('not json'), sdkError]);
    const err = await failure(
      createAnthropicProvider(OPTIONS, { client }).generateReport(request(), signal()),
    );
    expect(err.code).toBe('llm_unavailable');
    expect(err.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
    });
    expect((err.cause as Error).cause ?? err.cause).toBeDefined();
  });

  it('LLM-08 maps input, output, cache-read and cache-write tokens, treating absent cache fields as zero', async () => {
    const { client } = fakeClient([
      message(fakeReport(), { usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: null }),
    ]);
    const provider = createAnthropicProvider(OPTIONS, { client });
    const res = await provider.generateReport(request(), signal());
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(res.stopReason).toBe('unknown');
    expect(provider.id).toBe('anthropic');
    expect(
      provider.estimateCostUsd({
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(24);
  });

  it.each([
    ['401', new Anthropic.AuthenticationError(401, undefined, 'bad key', headers), 'llm_auth'],
    ['403', new Anthropic.PermissionDeniedError(403, undefined, 'denied', headers), 'llm_auth'],
    ['429', new Anthropic.RateLimitError(429, undefined, 'slow down', headers), 'llm_unavailable'],
    ['500', new Anthropic.InternalServerError(500, undefined, 'oops', headers), 'llm_unavailable'],
    ['connection', new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'llm_unavailable'],
    ['404', new Anthropic.NotFoundError(404, undefined, 'no model', headers), 'config_invalid'],
    ['400', new Anthropic.BadRequestError(400, undefined, 'bad effort', headers), 'config_invalid'],
    ['abort', new Anthropic.APIUserAbortError(), 'cancelled'],
  ] as const)('SPEC §10 maps an SDK %s error to %s → %s', async (_label, sdkError, code) => {
    const { client } = fakeClient([sdkError]);
    const err = await failure(
      createAnthropicProvider(OPTIONS, { client }).generateReport(request(), signal()),
    );
    expect(err.code).toBe(code);
    expect(err.cause).toBe(sdkError);
    expect(err.userMessage).not.toContain('test-key');
  });

  it('SPEC §10 reports cancellation when the signal is already aborted, and passes unknown errors through', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const a = fakeClient([new Error('socket closed')]);
    const err = await failure(
      createAnthropicProvider(OPTIONS, { client: a.client }).generateReport(request(), aborted.signal),
    );
    expect(err.code).toBe('cancelled');
    expect(a.calls[0]?.signal).toBe(aborted.signal);

    const boom = new Error('unexpected');
    const b = fakeClient([boom]);
    await expect(
      createAnthropicProvider(OPTIONS, { client: b.client }).generateReport(request(), signal()),
    ).rejects.toBe(boom);
  });

  it('LLM-08 warns once at creation when the model has no listed price', () => {
    const logger = silentLogger();
    const provider = createAnthropicProvider(
      { ...OPTIONS, model: 'claude-next' },
      { client: fakeClient([]).client, logger },
    );
    expect(logger.lines).toEqual([expect.stringContaining('No price is listed for model "claude-next"')]);
    expect(
      provider.estimateCostUsd({
        inputTokens: 1e6,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(5);
  });

  it('LLM-01 builds a real SDK client when none is injected (no request is made)', () => {
    const provider = createAnthropicProvider(OPTIONS);
    expect(provider.id).toBe('anthropic');
  });
});

describe('generateStructured — any schema-shaped output (SPEC v3, plan and verify calls)', () => {
  const Shape = z.object({ cases: z.array(z.object({ title: z.string() })) });
  const call = (overrides: Partial<StructuredRequest<z.infer<typeof Shape>>> = {}) => ({
    system: ['method text', 'language text'],
    prefix: ['<spec>the spec</spec>', '<existing_cases>(none)</existing_cases>'],
    tail: '<task>AC1</task>',
    schema: Shape,
    ...overrides,
  });

  it('SPEC v3 sends system, cached prefix and tail in that order, with the schema of the call', async () => {
    const { client, calls } = fakeClient([message({ cases: [{ title: 'Limit reached' }] })]);
    const provider = createAnthropicProvider(OPTIONS, { client });
    const result = await provider.generateStructured(call(), signal());

    expect(result.value).toEqual({ cases: [{ title: 'Limit reached' }] });
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
    });
    const body = calls[0]?.body;
    expect(body.system).toEqual([
      { type: 'text', text: 'method text' },
      { type: 'text', text: 'language text', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '<spec>the spec</spec>', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<existing_cases>(none)</existing_cases>', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<task>AC1</task>' },
    ]);
    expect(body.output_config.format.type).toBe('json_schema');
    expect(JSON.stringify(body.output_config.format.schema)).toContain('"cases"');
    expect(JSON.stringify(body.output_config.format.schema)).not.toContain('prdAlignment');
    expect(body.max_tokens).toBe(32_000);
  });

  it('LLM-06 never uses more than four cache breakpoints, however many prefix blocks a call has', async () => {
    const { client, calls } = fakeClient([message({ cases: [] })]);
    await createAnthropicProvider(OPTIONS, { client }).generateStructured(
      call({ prefix: ['a', 'b', 'c', 'd', 'e'] }),
      signal(),
    );
    const content = calls[0]?.body.messages[0].content as { text: string; cache_control?: unknown }[];
    expect(content.map((b) => b.text)).toEqual(['a\nb\nc', 'd', 'e', '<task>AC1</task>']);
    const breakpoints = content.filter((b) => b.cache_control).length + 1; // plus the system one
    expect(breakpoints).toBe(4);
  });

  it("LLM-02/04 validates against the call's schema, retries a bad shape once, and names the output in errors", async () => {
    const retried = fakeClient([message({ wrong: true }), message({ cases: [{ title: 'ok' }] })]);
    const ok = await createAnthropicProvider(OPTIONS, {
      client: retried.client,
      logger: silentLogger(),
    }).generateStructured(call({ what: 'QA case' }), signal());
    expect(ok.value.cases).toHaveLength(1);
    expect(ok.usage.inputTokens).toBe(2_000); // both attempts are billed

    const bad = fakeClient([message({ wrong: true }), message('not json')]);
    const schema = await failure(
      createAnthropicProvider(OPTIONS, { client: bad.client, logger: silentLogger() }).generateStructured(
        call({ what: 'QA case' }),
        signal(),
      ),
    );
    expect(schema).toMatchObject({
      code: 'llm_schema',
      userMessage: 'The model response did not match the QA case schema after a retry.',
    });

    const refused = fakeClient([
      message({}, { stop_reason: 'refusal', stop_details: { category: 'cyber' } }),
    ]);
    const refusal = await failure(
      createAnthropicProvider(OPTIONS, { client: refused.client }).generateStructured(
        call({ subject: 'spec' }),
        signal(),
      ),
    );
    expect(refusal.userMessage).toBe('The model declined to analyze this spec (category: cyber).');

    const cut = fakeClient([message({ cases: [] }, { stop_reason: 'max_tokens' })]);
    expect(
      (
        await failure(
          createAnthropicProvider(OPTIONS, { client: cut.client }).generateStructured(call(), signal()),
        )
      ).code,
    ).toBe('llm_truncated');
  });
});
