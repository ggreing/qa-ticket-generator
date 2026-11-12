import { describe, expect, it } from 'vitest';
import { estimateCostUsd, PRICING, resolvePrice, UNKNOWN_MODEL_PRICE } from '../../src/llm/pricing';

describe('pricing (LLM-08)', () => {
  it('LLM-08 prices Opus 5.5 at $4 / $20 per MTok with $0.20 cache reads and 1.25x cache writes', () => {
    expect(PRICING['claude-opus-5-5']).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 5,
    });
  });

  it('LLM-08 estimates cost from input, output and cache tokens', () => {
    const cost = estimateCostUsd('claude-opus-5-5', {
      inputTokens: 31_200,
      outputTokens: 5_800,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 10_000,
    });
    // 31.2K*4 + 5.8K*20 + 100K*0.2 + 10K*5 = 124_800 + 116_000 + 20_000 + 50_000 (per million)
    expect(cost).toBeCloseTo(0.3108, 6);
  });

  it('LLM-08 accepts dated snapshots of a listed model', () => {
    expect(resolvePrice('claude-haiku-4-5-20251001')).toEqual({
      price: PRICING['claude-haiku-4-5'],
      known: true,
    });
    expect(resolvePrice(' Claude-Opus-5-5 ').known).toBe(true);
  });

  it('LLM-08 falls back to conservative Opus-tier rates for an unknown model', () => {
    expect(resolvePrice('some-future-model')).toEqual({ price: UNKNOWN_MODEL_PRICE, known: false });
    // A different model family that merely shares a prefix must not inherit that model's price.
    expect(resolvePrice('claude-opus-5-9').known).toBe(false);
    expect(
      estimateCostUsd('some-future-model', {
        inputTokens: 1e6,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(5);
  });
});
