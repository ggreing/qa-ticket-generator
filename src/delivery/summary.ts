/** Job Summary / CLI stdout deliverer + report.json (DLV-07). Owner: qa-work-session-c(fable). */
import type { Deliverer } from '../core/contracts';
import { notImplemented } from '../core/stub';

export interface SummarySink {
  writeMarkdown(markdown: string): Promise<void>;
  /** Writes report.json and returns its path (Action: RUNNER_TEMP; CLI: --out). */
  writeJson(json: string): Promise<string | null>;
}

export function createSummaryDeliverer(_sink: SummarySink): Deliverer {
  return notImplemented('delivery/createSummaryDeliverer');
}
