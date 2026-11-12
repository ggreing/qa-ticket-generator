/** Job Summary / CLI stdout deliverer + report.json (DLV-07). Owner: qa-work-session-c(fable). */
import type { Deliverer } from '../core/contracts';
import { renderSummaryMarkdown } from './render/markdown';

export interface SummarySink {
  writeMarkdown(markdown: string): Promise<void>;
  /** Writes report.json and returns its path (Action: RUNNER_TEMP; CLI: --out). */
  writeJson(json: string): Promise<string | null>;
}

/**
 * DLV-07 — always-on channel: writes the full report (no length cap, with skipped files and their
 * reasons) as Markdown and the complete `FinalReport` as JSON. Never throws; a sink failure is
 * returned as a warning so the other channels are unaffected (DLV-08).
 */
export function createSummaryDeliverer(sink: SummarySink): Deliverer {
  return {
    channel: 'summary',
    async deliver(final) {
      let ok = true;
      let path: string | null = null;
      try {
        await sink.writeMarkdown(renderSummaryMarkdown(final));
      } catch {
        ok = false;
      }
      try {
        path = await sink.writeJson(`${JSON.stringify(final, null, 2)}\n`);
      } catch {
        ok = false;
      }
      return {
        channel: 'summary',
        ok,
        ...(path ? { url: path } : {}),
        ...(ok
          ? {}
          : { warning: { code: 'other', message: 'Could not write the job summary or report.json.' } }),
      };
    },
  };
}
