/** single / map-reduce orchestration + cost guard (LLM-07/10). Owner: qa-work-session-c(fable). */
import type {
  LlmProvider,
  OrchestrateOptions,
  OrchestrateResult,
  PreprocessOutput,
  PromptContext,
} from '../core/contracts';
import { notImplemented } from '../core/stub';

export async function orchestrate(
  _pre: PreprocessOutput,
  _provider: LlmProvider,
  _context: PromptContext,
  _options: OrchestrateOptions,
  _signal: AbortSignal,
): Promise<OrchestrateResult> {
  return notImplemented('llm/orchestrate');
}
