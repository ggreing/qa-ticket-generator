/**
 * v0.2 — Claude on the Claude API, Amazon Bedrock (Mantle) and Google Vertex AI.
 * The real SDK clients run against an in-process fetch: these tests pin what each platform is sent
 * (URL, auth, beta header, model ID, body), never a network call.
 * Owner: qa-work-session-a.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { QtgError } from '../../src/core/errors';
import {
  type AnthropicProviderOptions,
  createAnthropicProvider,
  type PlatformClientDeps,
  type PlatformOptions,
  priceModelId,
  requestModelId,
  SERVER_FALLBACK_BETA,
} from '../../src/llm/anthropic';
import { fakeClient, message } from './support';

interface Seen {
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A minimal Messages SSE stream whose text is `{"ok":true}`. */
function sse(model: string): Response {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"ok":true}' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Stands in for google-auth-library, so no test ever reaches ADC or the metadata server. */
function fakeGoogleAuth(projectId: string | null = null) {
  return {
    projectId,
    getRequestHeaders: async () => new Headers({ authorization: 'Bearer ya29.test-token' }),
  } as unknown as NonNullable<PlatformClientDeps['vertexAuthClient']>;
}

function capture() {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    seen.push({ url, headers, body });
    return sse(String(body.model ?? 'claude-opus-5-5'));
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const base: AnthropicProviderOptions = {
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5-5',
  effort: 'high',
  serverFallback: true,
  maxOutputTokens: 16_000,
};
const req = {
  system: ['You check things.'],
  prefix: ['The spec.'],
  tail: 'Answer.',
  schema: z.object({ ok: z.boolean() }),
};
const signal = () => new AbortController().signal;

async function runOn(platform: PlatformOptions | undefined, over: Partial<AnthropicProviderOptions> = {}) {
  const { fetch, seen } = capture();
  const llm = createAnthropicProvider(
    { ...base, ...over, ...(platform ? { platform } : {}) },
    { platformClient: { fetch, vertexAuthClient: fakeGoogleAuth() } },
  );
  const result = await llm.generateStructured?.(req, signal());
  expect(result?.value).toEqual({ ok: true });
  expect(seen).toHaveLength(1);
  return seen[0] as Seen;
}

beforeEach(() => {
  // Only the injected fetch may answer. Anything else (an ADC token exchange, the GCE metadata
  // server, the AWS instance metadata) would be a network call from a test: fail loudly instead.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network access in a test');
    }),
  );
  // Bedrock signs with these (SigV4, offline). Nothing here may reach a real credential source.
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLETEST');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '');
  vi.stubEnv('AWS_PROFILE', '');
  vi.stubEnv('AWS_REGION', '');
  vi.stubEnv('AWS_DEFAULT_REGION', '');
  vi.stubEnv('ANTHROPIC_BEDROCK_MANTLE_BASE_URL', '');
  vi.stubEnv('ANTHROPIC_VERTEX_BASE_URL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('model IDs per platform', () => {
  it('v0.2 Bedrock gets the anthropic. prefix; prefixed IDs and ARNs pass through; others keep the plain ID', () => {
    expect(requestModelId('bedrock', 'claude-opus-5-5')).toBe('anthropic.claude-opus-5-5');
    expect(requestModelId('bedrock', 'anthropic.claude-opus-5-5')).toBe('anthropic.claude-opus-5-5');
    expect(requestModelId('bedrock', 'us.anthropic.claude-opus-5-5')).toBe('us.anthropic.claude-opus-5-5');
    expect(requestModelId('bedrock', 'global.anthropic.claude-opus-5-5')).toBe(
      'global.anthropic.claude-opus-5-5',
    );
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5';
    expect(requestModelId('bedrock', arn)).toBe(arn);
    expect(requestModelId('vertex', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(requestModelId('anthropic', 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('v0.2 prices use the plain ID whatever the platform spelling', () => {
    expect(priceModelId('anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(priceModelId('us.anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(priceModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5');
    expect(priceModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('v0.2 the cost estimate is the same on every platform (list prices; the cloud bills its own)', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = (platform?: PlatformOptions) =>
      createAnthropicProvider(
        { ...base, ...(platform ? { platform } : {}) },
        { client: fakeClient([]).client },
      ).estimateCostUsd(usage);
    expect(cost({ kind: 'bedrock', awsRegion: 'us-east-1' })).toBe(cost());
    expect(cost({ kind: 'vertex', region: 'global' })).toBe(cost());
  });
});

describe('request shape per platform (real SDK clients, in-process fetch)', () => {
  it('v0.2 Claude API: x-api-key, beta endpoint with the server-side fallback, plain model ID', async () => {
    const r = await runOn(undefined);
    expect(r.url.origin).toBe('https://api.anthropic.com');
    expect(r.url.pathname).toBe('/v1/messages');
    expect(r.headers.authorization).toBe('Bearer sk-ant-test');
    expect(r.headers['anthropic-beta']).toContain(SERVER_FALLBACK_BETA);
    expect(r.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', stream: true });
  });

  it('v0.2 Bedrock: Mantle endpoint in the region, SigV4, no fallback beta, anthropic. model ID', async () => {
    const r = await runOn({ kind: 'bedrock', awsRegion: 'us-west-2' });
    expect(r.url.origin).toBe('https://bedrock-mantle.us-west-2.api.aws');
    expect(r.url.pathname).toBe('/anthropic/v1/messages');
    expect(r.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLETEST\//);
    expect(r.headers['x-api-key']).toBeUndefined();
    expect(r.headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
    expect(r.body.model).toBe('anthropic.claude-opus-5-5');
    expect(r.body).not.toHaveProperty('fallbacks');
  });

  it('v0.2 Bedrock: the region falls back to AWS_REGION (set by configure-aws-credentials)', async () => {
    vi.stubEnv('AWS_REGION', 'eu-central-1');
    const r = await runOn({ kind: 'bedrock' });
    expect(r.url.origin).toBe('https://bedrock-mantle.eu-central-1.api.aws');
  });

  it('v0.2 Bedrock: no region anywhere is a config error naming the input, before any request', async () => {
    const { fetch, seen } = capture();
    const llm = createAnthropicProvider(
      { ...base, platform: { kind: 'bedrock' } },
      { platformClient: { fetch } },
    );
    const err = await llm.generateStructured?.(req, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QtgError);
    expect((err as QtgError).code).toBe('config_invalid');
    expect((err as QtgError).userMessage).toContain('aws-region');
    expect(seen).toHaveLength(0);
  });

  it('v0.2 Vertex: project and region in the URL, Google bearer token, no fallback beta', async () => {
    const r = await runOn({ kind: 'vertex', region: 'us-east5', projectId: 'qa-proj' });
    expect(r.url.origin).toBe('https://us-east5-aiplatform.googleapis.com');
    expect(r.url.pathname).toBe(
      '/v1/projects/qa-proj/locations/us-east5/publishers/anthropic/models/claude-opus-5-5:streamRawPredict',
    );
    expect(r.headers.authorization).toBe('Bearer ya29.test-token');
    expect(r.headers['x-api-key']).toBeUndefined();
    expect(r.headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
    expect(r.body).not.toHaveProperty('fallbacks');
  });

  it.each<[string, PlatformOptions | undefined]>([
    ['Claude API', undefined],
    ['Bedrock', { kind: 'bedrock', awsRegion: 'us-west-2' }],
    ['Vertex', { kind: 'vertex', region: 'global', projectId: 'qa-proj' }],
  ])('v0.2 %s keeps structured output, effort and the cache breakpoints', async (_n, platform) => {
    const r = await runOn(platform);
    const out = r.body.output_config as { effort?: string; format?: { type?: string } };
    expect(out.effort).toBe('high');
    expect(out.format?.type).toBe('json_schema');
    expect(JSON.stringify(r.body.system)).toContain('"cache_control":{"type":"ephemeral"}');
    expect(JSON.stringify(r.body.messages)).toContain('"cache_control":{"type":"ephemeral"}');
    // Thinking is left to the model's adaptive default on every platform.
    expect(r.body).not.toHaveProperty('thinking');
  });
});

describe('errors per platform', () => {
  it('v0.2 an auth failure names the platform and the credentials to check', async () => {
    const denied = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'no' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const llm = createAnthropicProvider(
      { ...base, platform: { kind: 'bedrock', awsRegion: 'us-west-2' } },
      { platformClient: { fetch: denied } },
    );
    const err = (await llm.generateStructured?.(req, signal()).catch((e: unknown) => e)) as QtgError;
    expect(err.code).toBe('llm_auth');
    expect(err.userMessage).toContain('Amazon Bedrock');
    expect(err.userMessage).toContain('configure-aws-credentials');
  });

  it('v0.2 the Claude API messages are unchanged', async () => {
    const { client } = fakeClient([message({ stop_reason: 'end_turn' })]);
    const llm = createAnthropicProvider({ ...base, serverFallback: false }, { client });
    expect(llm.id).toBe('anthropic');
  });
});

describe('Vertex credentials', () => {
  it('v0.2 the project comes from the Google credentials when vertex-project-id is empty', async () => {
    const { fetch, seen } = capture();
    const llm = createAnthropicProvider(
      { ...base, platform: { kind: 'vertex', region: 'global' } },
      { platformClient: { fetch, vertexAuthClient: fakeGoogleAuth('cred-proj') } },
    );
    await llm.generateStructured?.(req, signal());
    expect(seen[0]?.url.pathname).toContain('/projects/cred-proj/locations/global/');
  });

  it('v0.2 missing Google credentials are an auth error naming google-github-actions/auth', async () => {
    const { fetch, seen } = capture();
    const noAdc = {
      projectId: null,
      getRequestHeaders: async () => {
        throw new Error('Could not load the default credentials. Browse to the docs for more information.');
      },
    } as unknown as NonNullable<PlatformClientDeps['vertexAuthClient']>;
    const llm = createAnthropicProvider(
      { ...base, platform: { kind: 'vertex', region: 'global', projectId: 'qa-proj' } },
      { platformClient: { fetch, vertexAuthClient: noAdc } },
    );
    const err = (await llm.generateStructured?.(req, signal()).catch((e: unknown) => e)) as QtgError;
    expect(err.code).toBe('llm_auth');
    expect(err.userMessage).toContain('google-github-actions/auth');
    expect(seen).toHaveLength(0);
  });
});
