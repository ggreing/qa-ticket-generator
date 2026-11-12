/** Token-usage helpers shared by the provider and the orchestrator. Owner: qa-work-session-c(fable). */
import type { LlmUsage } from '../core/contracts';
import { QtgError, type QtgErrorCode, toQtgError } from '../core/errors';

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

export const isBilled = (usage: LlmUsage): boolean =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0;

/**
 * Builds a QtgError for a call that was billed but produced no usable report (refusal,
 * truncation, schema failure). `usage` is what the failed call(s) cost.
 */
export function billedError(code: QtgErrorCode, userMessage: string, usage: LlmUsage): QtgError {
  return new QtgError(code, userMessage, { usage });
}

/** Billed usage carried by a QtgError, or zero when the error carries none. */
export function usageFromError(err: unknown): LlmUsage {
  return err instanceof QtgError && err.usage ? err.usage : ZERO_USAGE;
}

/**
 * Returns `err` carrying `usage` as its billed total (replacing any usage it had), so the
 * pipeline can report real spend for a failed run. Errors with nothing billed pass through.
 */
export function withBilledUsage(err: unknown, usage: LlmUsage): unknown {
  if (!isBilled(usage)) return err;
  const e = toQtgError(err);
  return new QtgError(e.code, e.userMessage, { cause: e.cause ?? err, usage });
}
