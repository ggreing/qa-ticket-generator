/** Anthropic LlmProvider (SPEC §5.5, LLM-01..06/08). Owner: qa-work-session-c(fable). */
import type { Effort, LlmProvider } from '../core/contracts';
import { notImplemented } from '../core/stub';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  /** LLM-05 — server-side refusal fallback (beta). */
  serverFallback: boolean;
  maxOutputTokens: number;
}

export function createAnthropicProvider(_options: AnthropicProviderOptions): LlmProvider {
  return notImplemented('llm/createAnthropicProvider');
}
