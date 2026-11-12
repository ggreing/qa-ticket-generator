/**
 * Model price table (LLM-08). The single place prices live; amounts are USD per million tokens.
 * Source: Anthropic first-party API list prices as of 2026-11. Owner: qa-work-session-c(fable).
 */
import type { LlmUsage } from '../core/contracts';

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

/** Cache writes with the default 5-minute TTL cost 1.25x the base input price. */
const CACHE_WRITE_MULTIPLIER = 1.25;

const price = (inputPerMTok: number, outputPerMTok: number, cacheReadPerMTok: number): ModelPrice => ({
  inputPerMTok,
  outputPerMTok,
  cacheReadPerMTok,
  cacheWritePerMTok: inputPerMTok * CACHE_WRITE_MULTIPLIER,
});

/**
 * Cache reads are 0.1x input on most models; newer models publish a lower flat rate.
 * Claude Haiku 5.5 is listed at its base tier (prompts up to 100K tokens; longer prompts cost more).
 */
export const PRICING: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-2': price(8, 40, 0.2),
  'claude-mythos-5-2': price(8, 40, 0.2),
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-mythos-5-1': price(10, 50, 0.25),
  'claude-fable-5': price(10, 50, 1),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25, 0.5),
  'claude-opus-4-8': price(5, 25, 0.5),
  'claude-opus-4-7': price(5, 25, 0.5),
  'claude-opus-4-6': price(5, 25, 0.5),
  'claude-sonnet-5-5': price(2, 10, 0.1),
  'claude-sonnet-5': price(2, 10, 0.2),
  'claude-sonnet-4-6': price(3, 15, 0.3),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01),
  'claude-haiku-4-5': price(1, 5, 0.1),
};

/** Used for model ids missing from the table: legacy Opus rates, so the cost guard errs high. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = price(5, 25, 0.5);

const DATED_SUFFIX = /^[-@]\d{8}$/;

/** Looks up a model's price; `known` is false when the conservative fallback was used. */
export function resolvePrice(model: string): { price: ModelPrice; known: boolean } {
  const id = model.trim().toLowerCase();
  const exact = PRICING[id];
  if (exact) return { price: exact, known: true };
  // Accept dated snapshots of a listed model, e.g. `claude-haiku-4-5-20251001`.
  for (const [key, value] of Object.entries(PRICING)) {
    if (id.startsWith(key) && DATED_SUFFIX.test(id.slice(key.length))) return { price: value, known: true };
  }
  return { price: UNKNOWN_MODEL_PRICE, known: false };
}

/** LLM-08 — USD cost of a call (or a sum of calls) with the given token counts. */
export function estimateCostUsd(model: string, usage: LlmUsage): number {
  const { price: p } = resolvePrice(model);
  return (
    (usage.inputTokens * p.inputPerMTok +
      usage.outputTokens * p.outputPerMTok +
      usage.cacheReadTokens * p.cacheReadPerMTok +
      usage.cacheWriteTokens * p.cacheWritePerMTok) /
    1_000_000
  );
}
