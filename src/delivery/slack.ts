/** Slack Bot (post/update/thread) + Webhook fallback (DLV-04/05/06). Owner: qa-work-session-c(fable). */
import type { QtgConfig } from '../core/config';
import type { Deliverer, Logger } from '../core/contracts';
import { notImplemented } from '../core/stub';

export function createSlackDeliverer(_slack: QtgConfig['slack'], _logger: Logger): Deliverer | null {
  return notImplemented('delivery/createSlackDeliverer');
}
