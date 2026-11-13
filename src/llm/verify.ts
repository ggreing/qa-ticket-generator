/** Verify phase: cases + PR code -> code status per case + code-derived cases (SPEC v3 §2.2). Owner: qa-work-session-c(fable). */
import type { VerifyRequest, VerifyResult } from '../core/cases';
import type { LlmProvider } from '../core/contracts';
import { notImplemented } from '../core/stub';

export async function verifyCases(
  _req: VerifyRequest,
  _provider: LlmProvider,
  _options: { maxCostUsd: number; expectedOutputTokens: number },
  _signal: AbortSignal,
): Promise<VerifyResult> {
  return notImplemented('llm/verifyCases');
}
