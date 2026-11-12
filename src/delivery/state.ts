/** Hidden delivery state inside the PR comment (DLV-02, ADR-0004). Owner: qa-work-session-c(fable). */
import { z } from 'zod';
import type { DeliveryState } from '../core/contracts';

export const REPORT_MARKER = '<!-- qa-ticket-generator:report -->';
const STATE_OPEN = '<!-- qtg-state:';
const STATE_CLOSE = ' -->';
const STATE_PATTERN = /<!-- qtg-state:(.*?) -->/gs;

// The comment is editable by anyone with write access, so every field is validated before use.
const SlackTs = z.string().regex(/^\d{1,16}\.\d{1,9}$/);
const StateSchema = z.object({
  v: z.literal(1),
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional(),
  slack: z
    .object({
      channel: z.string().regex(/^[A-Z][A-Z0-9]{2,20}$/),
      ts: SlackTs,
      replies: z.array(SlackTs).max(200),
    })
    .optional(),
});

/**
 * Serializes the state as an HTML comment. `<` and `>` are written as JSON unicode escapes so a
 * value can never contain `-->` and close the comment early.
 */
export function serializeState(state: DeliveryState): string {
  const json = JSON.stringify(state).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${STATE_OPEN}${json}${STATE_CLOSE}`;
}

/**
 * Reads the state block from a comment body. `corrupted` is true when the block is absent,
 * is not JSON, or fails validation; callers then start from `{ v: 1 }` (DLV-02).
 */
export function parseState(body: string): { state: DeliveryState; corrupted: boolean } {
  const blocks = [...body.matchAll(STATE_PATTERN)];
  const raw = blocks.at(-1)?.[1]; // ours is always the last thing in the comment
  if (raw === undefined) return { state: { v: 1 }, corrupted: true };
  try {
    const parsed = StateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { state: parsed.data, corrupted: false };
  } catch {
    // fall through
  }
  return { state: { v: 1 }, corrupted: true };
}
