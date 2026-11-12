/** Token-usage helpers shared by the provider and the orchestrator. Owner: qa-work-session-c(fable). */
import type { LlmUsage } from '../core/contracts';
import { QtgError, type QtgErrorCode } from '../core/errors';

export const ZERO_USAGE: Readonly<LlmUsage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * Builds a QtgError for a call that was billed but produced no usable report (refusal,
 * truncation, schema failure). The usage rides on `cause` so the caller can still count it.
 */
export function billedError(code: QtgErrorCode, userMessage: string, usage: LlmUsage): QtgError {
  return new QtgError(code, userMessage, { cause: { usage } });
}

/** Usage attached by {@link billedError}, or zero when the error carries none. */
export function usageFromError(err: unknown): LlmUsage {
  const cause = err instanceof QtgError ? (err.cause as { usage?: LlmUsage } | undefined) : undefined;
  const usage = cause?.usage;
  if (usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') return usage;
  return ZERO_USAGE;
}
