/** Marker PR comment + hidden qtg-state storage (DLV-01/02/03). Owner: qa-work-session-c(fable). */
import type { PrCommentStore } from '../core/contracts';
import type { Octokit } from '../core/octokit';
import { notImplemented } from '../core/stub';

export function createPrCommentStore(_octokit: Octokit): PrCommentStore {
  return notImplemented('delivery/createPrCommentStore');
}
