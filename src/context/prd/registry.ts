/** Parallel PRD fetching with per-document timeout and warnings (PRD-02/08/09). Owner: qa-work-session-a. */
import type { PrdCollection, PrdProvider, PrdRef } from '../../core/contracts';
import { notImplemented } from '../../core/stub';

export async function collectPrdDocuments(
  _refs: PrdRef[],
  _providers: PrdProvider[],
  _options: { timeoutMs: number; signal: AbortSignal },
): Promise<PrdCollection> {
  return notImplemented('prd/collectPrdDocuments');
}
