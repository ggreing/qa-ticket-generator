/** Parallel PRD fetching with per-document timeout and warnings (PRD-02/08/09). Owner: qa-work-session-a. */
import type {
  PrdCollection,
  PrdDocument,
  PrdProvider,
  PrdRef,
  PrdSource,
  Warning,
} from '../../core/contracts';
import { abortable } from '../retry';
import { PrdFetchError } from './errors';

const SOURCE_LABEL: Record<PrdSource, string> = { github: 'GitHub', jira: 'Jira', notion: 'Notion' };
const SOURCE_SETUP: Record<PrdSource, string> = {
  github: 'github-token',
  jira: 'jira-base-url, jira-email and jira-api-token',
  notion: 'notion-token',
};

const label = (ref: PrdRef): string => `${ref.id} (${SOURCE_LABEL[ref.source]})`;

/**
 * Turns a fetch failure into a user-facing warning. Only messages we wrote ourselves
 * ({@link PrdFetchError}) are shown: arbitrary error messages can echo response bodies.
 */
function failureWarning(ref: PrdRef, err: unknown, timedOut: boolean, timeoutMs: number): Warning {
  if (timedOut) {
    return {
      code: 'prd_fetch_failed',
      message: `Timed out after ${Math.round(timeoutMs / 1000)}s fetching ${label(ref)}.`,
    };
  }
  if (err instanceof PrdFetchError) {
    return {
      code: err.kind === 'permission' ? 'prd_permission' : 'prd_fetch_failed',
      message: `Could not fetch ${label(ref)}: ${err.message}`,
    };
  }
  const name = err instanceof Error && err.name !== 'Error' ? ` (${err.name})` : '';
  return { code: 'prd_fetch_failed', message: `Could not fetch ${label(ref)}: unexpected error${name}.` };
}

/**
 * PRD-02/08/09 — fetches every reference through the provider registered for its source, in
 * parallel, each under `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`.
 *
 * - No provider, or `isConfigured()` false → `prd_source_unconfigured` (one warning per source).
 * - `PrdFetchError` of kind `permission` (GitHub 403/404, Jira 401/403, Notion 401/403/404) →
 *   `prd_permission` (PRD-10).
 * - Any other failure or timeout → `prd_fetch_failed`; the run continues.
 *
 * Documents keep the order of `refs`. Warning messages never contain document text.
 * If `signal` (the whole run) is aborted, the abort reason is rethrown.
 *
 * @param refs References from {@link extractPrdRefs}, in body order.
 * @param providers Registry: the first provider for each source is used.
 * @param options Per-document timeout and the run's cancellation signal.
 */
export async function collectPrdDocuments(
  refs: PrdRef[],
  providers: PrdProvider[],
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<PrdCollection> {
  const { timeoutMs, signal } = options;
  signal.throwIfAborted();
  const registry = new Map<PrdSource, PrdProvider>();
  for (const p of providers) if (!registry.has(p.source)) registry.set(p.source, p);

  const warnings: Warning[] = [];
  const unconfigured = new Map<PrdSource, PrdRef[]>();
  const jobs: { ref: PrdRef; provider: PrdProvider }[] = [];
  for (const ref of refs) {
    const provider = registry.get(ref.source);
    if (!provider?.isConfigured())
      unconfigured.set(ref.source, [...(unconfigured.get(ref.source) ?? []), ref]);
    else jobs.push({ ref, provider });
  }
  for (const [source, skipped] of unconfigured) {
    warnings.push({
      code: 'prd_source_unconfigured',
      message: `${SOURCE_LABEL[source]} is not configured (set ${SOURCE_SETUP[source]}); skipped ${skipped
        .map((r) => r.id)
        .join(', ')}.`,
    });
  }

  const results = await Promise.all(
    jobs.map(async ({ ref, provider }): Promise<PrdDocument | Warning> => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const docSignal = AbortSignal.any([signal, timeout]);
      try {
        return await abortable(provider.fetch(ref, docSignal), docSignal);
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        return failureWarning(ref, err, timeout.aborted, timeoutMs);
      }
    }),
  );

  const documents: PrdDocument[] = [];
  for (const r of results) {
    if ('code' in r) warnings.push(r);
    else documents.push(r);
  }
  return { documents, warnings };
}
