/** Anthropic LlmProvider (SPEC §5.5, LLM-01..06/08). Owner: qa-work-session-c(fable). */
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  Effort,
  GenerateRequest,
  LlmProvider,
  LlmResult,
  LlmUsage,
  Logger,
  MergeRequest,
  PromptContext,
  QaReport,
} from '../core/contracts';
import { QtgError } from '../core/errors';
import { QaReportSchema } from '../core/schema';
import { estimateCostUsd, resolvePrice } from './pricing';
import { buildReduceTail } from './prompts/reduce';
import { languageInstruction, SYSTEM_PROMPT } from './prompts/system';
import { buildGenerateTail, buildMetadataSection, buildPrdSection } from './prompts/user';
import { addUsage, billedError, withBilledUsage, ZERO_USAGE } from './usage';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  /** LLM-05 — server-side refusal fallback (beta). */
  serverFallback: boolean;
  maxOutputTokens: number;
}

/** LLM-05 — beta flag for `fallbacks: "default"` (routes a declined request by refusal category). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

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
  client?: AnthropicClientLike;
  logger?: Pick<Logger, 'warn'>;
}

const SCHEMA_ATTEMPTS = 2;
const EPHEMERAL = { type: 'ephemeral' } as const;
const TEXT = 'text' as const;

// LLM-02 — the SDK helper turns the zod schema into a Structured Outputs JSON schema and gives us
// the matching validator. Only the plain schema goes on the wire; validation runs here, after the
// stop_reason check, because the SDK's own auto-parse throws on a truncated reply before the
// caller can see why it was truncated.
const reportFormat = zodOutputFormat(QaReportSchema);
const OUTPUT_FORMAT = { type: reportFormat.type, schema: reportFormat.schema };

function toUsage(usage: LlmMessage['usage']): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function parseReport(message: LlmMessage): QaReport | null {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  if (text.trim() === '') return null;
  try {
    return reportFormat.parse(text);
  } catch {
    return null;
  }
}

/** Maps SDK failures to user-facing QtgErrors (SPEC §10). Messages never include request content. */
function mapError(err: unknown, model: string, signal: AbortSignal): unknown {
  if (err instanceof QtgError) return err;
  if (err instanceof Anthropic.APIUserAbortError || signal.aborted) {
    return new QtgError('cancelled', 'The run was cancelled.', { cause: err });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new QtgError(
      'llm_auth',
      'The Anthropic API key is missing, invalid, or not allowed to use this model. Check the anthropic-api-key secret.',
      { cause: err },
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new QtgError('config_invalid', `Model "${model}" was not found. Check the model input.`, {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 400 || status === 413 || status === 422) {
      return new QtgError(
        'config_invalid',
        `The Anthropic API rejected the request (HTTP ${status}). Check the model, effort and token-budget inputs.`,
        { cause: err },
      );
    }
    // 429, 5xx, connection errors and mid-stream errors, after the SDK's own retries.
    return new QtgError(
      'llm_unavailable',
      `The Anthropic API was unavailable${status ? ` (HTTP ${status})` : ''} after retries. Re-run the workflow to try again.`,
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
): LlmProvider {
  const client: AnthropicClientLike = deps.client ?? new Anthropic({ apiKey: options.apiKey });
  const { logger } = deps;
  if (!resolvePrice(options.model).known) {
    logger?.warn(
      `No price is listed for model "${options.model}"; cost estimates use Opus-tier rates and may be off.`,
    );
  }

  // LLM-06 — a cache entry is readable only once the response that writes it starts streaming.
  // The first map call of a run therefore goes alone until its first stream event; the rest wait
  // for that moment and then read the shared PRD prefix instead of each paying to write it.
  const warmPrefixes = new Map<string, Promise<void>>();

  // The return type is inferred so the same literal satisfies both the stable and beta params.
  function buildBody(context: PromptContext, tail: string) {
    return {
      model: options.model,
      max_tokens: options.maxOutputTokens,
      output_config: { effort: options.effort, format: OUTPUT_FORMAT },
      system: [
        { type: TEXT, text: SYSTEM_PROMPT },
        { type: TEXT, text: languageInstruction(context.language), cache_control: EPHEMERAL },
      ],
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: TEXT, text: buildPrdSection(context), cache_control: EPHEMERAL },
            { type: TEXT, text: buildMetadataSection(context), cache_control: EPHEMERAL },
            { type: TEXT, text: tail },
          ],
        },
      ],
    };
  }

  type Body = ReturnType<typeof buildBody>;

  function startStream(body: Body, signal: AbortSignal): LlmStream {
    if (!options.serverFallback) return client.messages.stream(body, { signal });
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
      const stream = startStream(body, signal);
      if (release) stream.on('streamEvent', release);
      return await stream.finalMessage();
    } catch (err) {
      throw mapError(err, options.model, signal);
    } finally {
      release?.();
    }
  }

  async function request(
    context: PromptContext,
    tail: string,
    signal: AbortSignal,
    sharePrefix: boolean,
  ): Promise<LlmResult<QaReport>> {
    const body = buildBody(context, tail);
    const prefixKey = sharePrefix
      ? createHash('sha256')
          .update(JSON.stringify([body.system, buildPrdSection(context), buildMetadataSection(context)]))
          .digest('hex')
      : null;
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
          `The model declined to analyze this change${category ? ` (category: ${category})` : ''}.`,
          usage,
        );
      }
      if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
        throw billedError('llm_truncated', 'The model response was cut off before it finished.', usage);
      }
      const value = parseReport(message);
      if (value) return { value, usage, model: message.model, stopReason: message.stop_reason ?? 'unknown' };
      logger?.warn(`LLM response did not match the report schema (attempt ${attempt}/${SCHEMA_ATTEMPTS}).`);
    }
    throw billedError(
      'llm_schema',
      'The model response did not match the report schema after a retry.',
      usage,
    );
  }

  return {
    id: 'anthropic',
    generateReport: (req: GenerateRequest, signal: AbortSignal) =>
      request(req.context, buildGenerateTail(req), signal, req.phase === 'map'),
    mergeReports: (req: MergeRequest, signal: AbortSignal) =>
      request(req.context, buildReduceTail(req), signal, false),
    estimateCostUsd: (usage: LlmUsage) => estimateCostUsd(options.model, usage),
  };
}
