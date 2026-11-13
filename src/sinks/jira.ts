/** jira case sink (SPEC v3 §5). Owner: qa-work-session-a. */
import type { CaseSink, SinkContext } from '../core/cases';
import { notImplemented } from '../core/stub';

export function createJiraCaseSink(
  _options: { baseUrl: string; email: string; apiToken: string; subtaskType: string } | null,
  _ctx: SinkContext,
): CaseSink {
  return notImplemented('sinks/jira');
}
