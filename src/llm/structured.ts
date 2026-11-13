/**
 * A provider call that returns any schema-shaped value, not only a v2 report. The v3 plan and
 * verify phases need their own output shapes, and the `LlmProvider` contract in core only has
 * the two report calls, so this module adds the generic one beside it.
 * Owner: qa-work-session-c(fable).
 */
import type { z } from 'zod';
import type { LlmProvider, LlmResult } from '../core/contracts';
import { QtgError } from '../core/errors';

export interface StructuredRequest<T> {
  /** System text, most stable first. The last block carries the cache breakpoint. */
  system: string[];
  /** User text that every call of a run repeats (the spec, the case list). Cached. */
  prefix: string[];
  /** What differs per call: the part of the work to do, and the instruction. Not cached. */
  tail: string;
  /** Output shape. Plain objects, arrays, enums and strings only (Structured Outputs). */
  schema: z.ZodType<T>;
  /** True when several calls share system + prefix: the first warms the cache, the rest wait for it. */
  sharePrefix?: boolean;
  /** Word for the output in error messages ("report", "QA case"). */
  what?: string;
  /** Word for what is analyzed in a refusal message ("change", "spec"). */
  subject?: string;
}

export interface StructuredProvider extends LlmProvider {
  generateStructured<T>(req: StructuredRequest<T>, signal: AbortSignal): Promise<LlmResult<T>>;
}

/** The provider as a structured provider, or a clear error when it cannot make generic calls. */
export function asStructured(provider: LlmProvider): StructuredProvider {
  if (typeof (provider as Partial<StructuredProvider>).generateStructured !== 'function') {
    throw new QtgError(
      'internal',
      `The LLM provider "${provider.id}" cannot produce QA cases: it has no structured call.`,
    );
  }
  return provider as StructuredProvider;
}
