/** Anthropic LlmProvider (SPEC §5.5, LLM-01..06/08). Owner: qa-work-session-c(fable). */
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { z } from 'zod';
import type { LlmPlatform } from '../core/config';
import type {
  Effort,
  GenerateRequest,
  LlmResult,
  LlmUsage,
  Logger,
  MergeRequest,
  QaReport,
} from '../core/contracts';
import { QtgError } from '../core/errors';
import { QaReportSchema } from '../core/schema';
import { estimateCostUsd, resolvePrice } from './pricing';
import { buildReduceTail } from './prompts/reduce';
import { languageInstruction, SYSTEM_PROMPT } from './prompts/system';
import { buildGenerateTail, buildMetadataSection, buildPrdSection } from './prompts/user';
import type { StructuredProvider, StructuredRequest } from './structured';
import { addUsage, billedError, withBilledUsage, ZERO_USAGE } from './usage';

/** Where the requests go (v0.2). Bedrock and Vertex use the cloud's credentials, never an API key. */
export type PlatformOptions =
  | { kind: 'anthropic' }
  /** `awsRegion` '' or absent: AWS_REGION, then AWS_DEFAULT_REGION. */
  | { kind: 'bedrock'; awsRegion?: string }
  /** `projectId` '' or absent: resolved from the Google credentials (ADC). */
  | { kind: 'vertex'; region: string; projectId?: string };

export interface AnthropicProviderOptions {
  /** Claude API key; unused on Bedrock and Vertex. */
  apiKey: string;
  model: string;
  effort: Effort;
  /** LLM-05 — server-side refusal fallback (beta). Claude API only; ignored on Bedrock and Vertex. */
  serverFallback: boolean;
  maxOutputTokens: number;
  /** Default: the Claude API. */
  platform?: PlatformOptions;
}

/** LLM-05 — beta flag for `fallbacks: "default"` (routes a declined request by refusal category). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const PLATFORM_NAME: Record<LlmPlatform, string> = {
  anthropic: 'Anthropic API',
  bedrock: 'Amazon Bedrock',
  vertex: 'Vertex AI',
};
const AUTH_HINT: Record<LlmPlatform, string> = {
  anthropic: 'Check the anthropic-api-key secret.',
  bedrock:
    'Check the AWS credentials (aws-actions/configure-aws-credentials) and that the model is enabled for the account in this region.',
  vertex:
    'Check the Google credentials (google-github-actions/auth) and that Claude is enabled for the project.',
};

/**
 * The model ID a platform expects. Bedrock IDs carry an `anthropic.` prefix
 * (`anthropic.claude-opus-5-5`); an ID that already names one (`us.anthropic.…`, `global.anthropic.…`)
 * or an ARN is used as given. The Claude API and Vertex take the plain ID.
 */
export function requestModelId(platform: LlmPlatform, model: string): string {
  if (platform !== 'bedrock') return model;
  if (model.startsWith('arn:') || /(^|\.)anthropic\./.test(model)) return model;
  return `anthropic.${model}`;
}

/** The plain model ID prices are listed under: no Bedrock prefix, no Vertex `@date`. */
export function priceModelId(model: string): string {
  return model.replace(/^(?:[a-z]{2,8}\.)?anthropic\./, '').replace(/@\d{8}$/, '');
}

type VertexAuthClient = NonNullable<ConstructorParameters<typeof AnthropicVertex>[0]>['authClient'];

export interface PlatformClientDeps {
  /** Tests: a fetch that never leaves the process. */
  fetch?: typeof fetch;
  /**
   * Tests: a Google auth client. Without one the Vertex client starts Application Default
   * Credentials as soon as it is constructed (which may probe the GCE metadata server).
   */
  vertexAuthClient?: VertexAuthClient;
}

/**
 * Builds the SDK client for the platform. The Bedrock and Vertex SDKs are imported only when used,
 * so the Claude API path never loads the AWS or Google libraries.
 */
export async function createPlatformClient(
  options: Pick<AnthropicProviderOptions, 'apiKey' | 'platform'>,
  deps: PlatformClientDeps = {},
): Promise<AnthropicClientLike> {
  const platform = options.platform ?? { kind: 'anthropic' };
  const shared = deps.fetch ? { fetch: deps.fetch } : {};
  if (platform.kind === 'bedrock') {
    const awsRegion = platform.awsRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!awsRegion) {
      throw new QtgError(
        'config_invalid',
        'Amazon Bedrock needs a region: set the aws-region input or AWS_REGION (aws-actions/configure-aws-credentials sets it).',
      );
    }
    const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
    // No apiKey: SigV4 with the AWS credential chain (OIDC role in Actions), or AWS_BEARER_TOKEN_BEDROCK.
    return new AnthropicBedrockMantle({ awsRegion, ...shared });
  }
  if (platform.kind === 'vertex') {
    const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk');
    return new AnthropicVertex({
      region: platform.region,
      ...(platform.projectId ? { projectId: platform.projectId } : {}),
      ...(deps.vertexAuthClient ? { authClient: deps.vertexAuthClient } : {}),
      ...shared,
    });
  }
  return new Anthropic({ apiKey: options.apiKey, ...shared });
}

/**
 * Credential lookups fail outside the SDK's typed errors, often wrapped (the Vertex SDK reports a
 * failed token lookup as an APIConnectionError with the Google error as `cause`). Map the known
 * ones to llm_auth instead of "unavailable".
 */
function isCredentialError(err: unknown, depth = 0): boolean {
  if (!(err instanceof Error) || depth > 4) return false;
  if (
    err.name === 'CredentialsProviderError' || // @aws-sdk credential chain
    err.message.startsWith('Could not load the default credentials') // google-auth-library ADC
  ) {
    return true;
  }
  return isCredentialError((err as { cause?: unknown }).cause, depth + 1);
}

/** The part of a streamed response this module reads. */
export interface LlmMessage {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export interface LlmStream {
  on(event: 'streamEvent', listener: () => void): unknown;
  finalMessage(): Promise<LlmMessage>;
}

type StreamBody = Parameters<Anthropic['messages']['stream']>[0];
type BetaStreamBody = Parameters<Anthropic['beta']['messages']['stream']>[0];

/** Structural slice of the SDK client, so tests can inject a fake (no network in tests). */
export interface AnthropicClientLike {
  messages: { stream(body: StreamBody, options?: { signal?: AbortSignal }): LlmStream };
  beta: { messages: { stream(body: BetaStreamBody, options?: { signal?: AbortSignal }): LlmStream } };
}

export interface AnthropicProviderDeps {
  /** Tests: a fake client; otherwise createPlatformClient builds the SDK client on first use. */
  client?: AnthropicClientLike;
  /** Tests: hooks for the real SDK client (fetch, Vertex token). */
  platformClient?: PlatformClientDeps;
  logger?: Pick<Logger, 'warn'>;
}

const SCHEMA_ATTEMPTS = 2;
const EPHEMERAL = { type: 'ephemeral' } as const;
const TEXT = 'text' as const;

// LLM-02 — the SDK helper turns the zod schema into a Structured Outputs JSON schema and gives us
// the matching validator. Only the plain schema goes on the wire; validation runs here, after the
// stop_reason check, because the SDK's own auto-parse throws on a truncated reply before the
// caller can see why it was truncated.
type OutputFormat = ReturnType<typeof zodOutputFormat>;
const formats = new WeakMap<z.ZodType, OutputFormat>();
function formatFor(schema: z.ZodType): OutputFormat {
  let format = formats.get(schema);
  if (!format) {
    format = zodOutputFormat(schema);
    formats.set(schema, format);
  }
  return format;
}

function toUsage(usage: LlmMessage['usage']): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function parseOutput<T>(message: LlmMessage, format: OutputFormat): T | null {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  if (text.trim() === '') return null;
  try {
    return format.parse(text) as T;
  } catch {
    return null;
  }
}

/** Maps SDK failures to user-facing QtgErrors (SPEC §10). Messages never include request content. */
function mapError(err: unknown, model: string, signal: AbortSignal, platform: LlmPlatform): unknown {
  if (err instanceof QtgError) return err;
  const name = PLATFORM_NAME[platform];
  // Sentence subject; the Claude API messages stay as they were before v0.2.
  const subject = platform === 'anthropic' ? 'The Anthropic API' : name;
  if (err instanceof Anthropic.APIUserAbortError || signal.aborted) {
    return new QtgError('cancelled', 'The run was cancelled.', { cause: err });
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    (platform !== 'anthropic' && isCredentialError(err))
  ) {
    const what = platform === 'anthropic' ? 'The Anthropic API key is' : `The ${name} credentials are`;
    return new QtgError(
      'llm_auth',
      `${what} missing, invalid, or not allowed to use this model. ${AUTH_HINT[platform]}`,
      { cause: err },
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new QtgError(
      'config_invalid',
      `Model "${model}" was not found${platform === 'anthropic' ? '' : ` on ${name}`}. Check the model input.`,
      { cause: err },
    );
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 400 || status === 413 || status === 422) {
      return new QtgError(
        'config_invalid',
        `${subject} rejected the request (HTTP ${status}). Check the model, effort and token-budget inputs.`,
        { cause: err },
      );
    }
    // 429, 5xx, connection errors and mid-stream errors, after the SDK's own retries.
    return new QtgError(
      'llm_unavailable',
      `${subject} was unavailable${status ? ` (HTTP ${status})` : ''} after retries. Re-run the workflow to try again.`,
      { cause: err },
    );
  }
  return err;
}

/**
 * LLM-01 — creates the Anthropic-backed provider.
 *
 * Requests stream (LLM-03) with Structured Outputs (LLM-02), prompt caching on the system prompt
 * and the PRD/metadata prefix (LLM-06), and optionally the server-side refusal fallback (LLM-05).
 * Thinking is left to the model's adaptive default; depth is set through `effort`.
 */
export function createAnthropicProvider(
  options: AnthropicProviderOptions,
  deps: AnthropicProviderDeps = {},
): StructuredProvider {
  const platform: LlmPlatform = options.platform?.kind ?? 'anthropic';
  const model = requestModelId(platform, options.model);
  const priceModel = priceModelId(options.model);
  // LLM-05 — server-side `fallbacks` exist on the Claude API only (Bedrock and Vertex reject them).
  const serverFallback = options.serverFallback && platform === 'anthropic';
  let client: Promise<AnthropicClientLike> | undefined = deps.client
    ? Promise.resolve(deps.client)
    : undefined;
  const getClient = () => {
    client ??= createPlatformClient(options, deps.platformClient).catch((err: unknown) => {
      client = undefined; // a later call may succeed (e.g. credentials that appear later)
      throw err;
    });
    return client;
  };
  const { logger } = deps;
  if (!resolvePrice(priceModel).known) {
    logger?.warn(
      `No price is listed for model "${options.model}"; cost estimates use Opus-tier rates and may be off.`,
    );
  }

  // LLM-06 — a cache entry is readable only once the response that writes it starts streaming.
  // The first map call of a run therefore goes alone until its first stream event; the rest wait
  // for that moment and then read the shared PRD prefix instead of each paying to write it.
  const warmPrefixes = new Map<string, Promise<void>>();

  // The return type is inferred so the same literal satisfies both the stable and beta params.
  // Cache breakpoints: one after the system text and one after each prefix block, so calls that
  // share the system prompt and the prefix read them from the cache (LLM-06). At most four
  // breakpoints are allowed, hence at most three prefix blocks.
  function buildBody(req: StructuredRequest<unknown>, format: OutputFormat) {
    const prefix =
      req.prefix.length > 3 ? [req.prefix.slice(0, -2).join('\n'), ...req.prefix.slice(-2)] : req.prefix;
    return {
      model,
      max_tokens: options.maxOutputTokens,
      output_config: { effort: options.effort, format: { type: format.type, schema: format.schema } },
      system: req.system.map((text, i) =>
        i === req.system.length - 1 ? { type: TEXT, text, cache_control: EPHEMERAL } : { type: TEXT, text },
      ),
      messages: [
        {
          role: 'user' as const,
          content: [
            ...prefix.map((text) => ({ type: TEXT, text, cache_control: EPHEMERAL })),
            { type: TEXT, text: req.tail },
          ],
        },
      ],
    };
  }

  type Body = ReturnType<typeof buildBody>;

  function startStream(client: AnthropicClientLike, body: Body, signal: AbortSignal): LlmStream {
    if (!serverFallback) return client.messages.stream(body, { signal });
    return client.beta.messages.stream(
      { ...body, betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' },
      { signal },
    );
  }

  async function send(body: Body, signal: AbortSignal, prefixKey: string | null): Promise<LlmMessage> {
    let release: (() => void) | undefined;
    if (prefixKey) {
      const warming = warmPrefixes.get(prefixKey);
      if (warming) {
        await warming;
      } else {
        warmPrefixes.set(
          prefixKey,
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
      }
    }
    try {
      const stream = startStream(await getClient(), body, signal);
      if (release) stream.on('streamEvent', release);
      return await stream.finalMessage();
    } catch (err) {
      throw mapError(err, model, signal, platform);
    } finally {
      release?.();
    }
  }

  /** One structured call: streams, checks why the model stopped, validates, retries a bad shape once. */
  async function generateStructured<T>(
    req: StructuredRequest<T>,
    signal: AbortSignal,
  ): Promise<LlmResult<T>> {
    const format = formatFor(req.schema);
    const body = buildBody(req, format);
    const prefixKey = req.sharePrefix
      ? createHash('sha256')
          .update(JSON.stringify([req.system, req.prefix]))
          .digest('hex')
      : null;
    const what = req.what ?? 'expected';
    let usage: LlmUsage = ZERO_USAGE;
    for (let attempt = 1; attempt <= SCHEMA_ATTEMPTS; attempt++) {
      const message = await send(body, signal, prefixKey).catch((err: unknown) => {
        throw withBilledUsage(err, usage); // an earlier attempt of this call may already be billed
      });
      usage = addUsage(usage, toUsage(message.usage));
      // LLM-04 — check why the model stopped before reading its content.
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        throw billedError(
          'llm_refusal',
          `The model declined to analyze this ${req.subject ?? 'change'}${category ? ` (category: ${category})` : ''}.`,
          usage,
        );
      }
      if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
        throw billedError('llm_truncated', 'The model response was cut off before it finished.', usage);
      }
      const value = parseOutput<T>(message, format);
      if (value) return { value, usage, model: message.model, stopReason: message.stop_reason ?? 'unknown' };
      logger?.warn(`LLM response did not match the ${what} schema (attempt ${attempt}/${SCHEMA_ATTEMPTS}).`);
    }
    throw billedError(
      'llm_schema',
      `The model response did not match the ${what} schema after a retry.`,
      usage,
    );
  }

  /** The v2 report calls, expressed as structured calls (same blocks, same order as before). */
  const report = (
    context: GenerateRequest['context'],
    tailText: string,
    signal: AbortSignal,
    sharePrefix: boolean,
  ) =>
    generateStructured<QaReport>(
      {
        system: [SYSTEM_PROMPT, languageInstruction(context.language)],
        prefix: [buildPrdSection(context), buildMetadataSection(context)],
        tail: tailText,
        schema: QaReportSchema,
        sharePrefix,
        what: 'report',
      },
      signal,
    );

  return {
    id: 'anthropic',
    generateReport: (req: GenerateRequest, signal: AbortSignal) =>
      report(req.context, buildGenerateTail(req), signal, req.phase === 'map'),
    mergeReports: (req: MergeRequest, signal: AbortSignal) =>
      report(req.context, buildReduceTail(req), signal, false),
    generateStructured,
    // Same list prices on every platform; Bedrock and Vertex bill on their own price lists.
    estimateCostUsd: (usage: LlmUsage) => estimateCostUsd(priceModel, usage),
  };
}
