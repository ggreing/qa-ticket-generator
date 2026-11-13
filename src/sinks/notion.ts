/** notion case sink (SPEC v3 §5). Owner: qa-work-session-a. */
import type { CaseSink, SinkContext } from '../core/cases';
import { notImplemented } from '../core/stub';

export function createNotionCaseSink(
  _options: { token: string; databaseId: string } | null,
  _ctx: SinkContext,
): CaseSink {
  return notImplemented('sinks/notion');
}
