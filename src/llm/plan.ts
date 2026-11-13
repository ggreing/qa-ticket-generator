/** Plan phase: spec -> exhaustive QA cases (SPEC v3 §2.1, §3.1, §6). Owner: qa-work-session-c(fable). */
import type { PlanRequest, PlanResult } from '../core/cases';
import type { LlmProvider } from '../core/contracts';
import { notImplemented } from '../core/stub';

export async function generatePlan(
  _req: PlanRequest,
  _provider: LlmProvider,
  _options: { maxCostUsd: number; expectedOutputTokens: number },
  _signal: AbortSignal,
): Promise<PlanResult> {
  return notImplemented('llm/generatePlan');
}
