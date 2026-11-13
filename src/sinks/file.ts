/** file case sink (SPEC v3 §5). Owner: qa-work-session-b. */
import type { CaseSink, SinkContext } from '../core/cases';
import { notImplemented } from '../core/stub';

export function createFileCaseSink(
  _options: { dir: string; previous: string | null },
  _ctx: SinkContext,
): CaseSink {
  return notImplemented('sinks/file');
}
