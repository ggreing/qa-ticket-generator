/** Retry with exponential backoff and rate-limit awareness (CTX-05). Owner: qa-work-session-a. */
import { setTimeout as sleepTimer } from 'node:timers/promises';

export interface RetryOptions {
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** First backoff delay; doubles on every retry (default 1000ms). */
  baseDelayMs?: number;
  /** Longest wait we accept; a server asking for more fails fast (default 60s). */
  maxDelayMs?: number;
  /** Injectable for tests. Must reject when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable clock for `x-ratelimit-reset` (epoch ms). */
  now?: () => number;
  /** Called before each wait. Receives only metadata, never response bodies. */
  onRetry?: (info: { attempt: number; delayMs: number; status: number | undefined }) => void;
}

/** Minimal shape shared by Octokit `RequestError` and our own HTTP errors. */
interface HttpLikeError {
  name?: string;
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | number | undefined> };
  headers?: Record<string, string | number | undefined>;
}

const DEFAULTS = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 } as const;

const defaultSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await sleepTimer(ms, undefined, signal ? { signal } : undefined);
};

/** HTTP status of an Octokit/HTTP error, if any. */
export function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as HttpLikeError).status;
  return typeof status === 'number' ? status : undefined;
}

function headerOf(err: HttpLikeError, name: string): string | undefined {
  const headers = err.response?.headers ?? err.headers;
  const value = headers?.[name];
  return value === undefined ? undefined : String(value);
}

/** True for GitHub primary/secondary rate-limit responses (403 or 429). */
export function isRateLimitError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== 403 && status !== 429) return false;
  if (status === 429) return true;
  const e = err as HttpLikeError;
  return (
    headerOf(e, 'retry-after') !== undefined ||
    headerOf(e, 'x-ratelimit-remaining') === '0' ||
    /rate limit/i.test(e.message ?? '')
  );
}

/**
 * True for cancellations. Octokit rethrows fetch's AbortError with `status = 500` attached, so
 * check this before looking at the status of an error.
 */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (err as HttpLikeError | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

const isAbort = isAbortError;

/**
 * Delay before the next attempt, or null when the error is not retryable.
 * Retryable: 5xx (Octokit reports network failures as 500), 429, and 403 rate limits.
 */
export function retryDelayMs(err: unknown, attempt: number, options: RetryOptions = {}): number | null {
  const status = statusOf(err);
  const rateLimited = isRateLimitError(err);
  if (status === undefined || (status < 500 && !rateLimited)) return null;

  const base = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelay = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  let delay = base * 2 ** attempt;

  const e = err as HttpLikeError;
  const retryAfter = Number(headerOf(e, 'retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.max(delay, retryAfter * 1_000);
  if (headerOf(e, 'x-ratelimit-remaining') === '0') {
    const reset = Number(headerOf(e, 'x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      const now = (options.now ?? Date.now)();
      delay = Math.max(delay, reset * 1_000 - now + 1_000);
    }
  }
  return delay > maxDelay ? null : delay;
}

/**
 * CTX-05 — runs `fn`, retrying 5xx and rate-limit failures with exponential backoff
 * (`retry-after` / `x-ratelimit-reset` honoured). Aborts are never retried.
 *
 * @param fn The request to run; called again from scratch on every retry.
 * @param options Retry tuning (see {@link RetryOptions}).
 * @param signal Stops waiting and rethrows when aborted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  signal?: AbortSignal,
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isAbort(err, signal) || attempt >= maxRetries) throw err;
      const delayMs = retryDelayMs(err, attempt, options);
      if (delayMs === null) throw err;
      options.onRetry?.({ attempt: attempt + 1, delayMs, status: statusOf(err) });
      await sleep(delayMs, signal);
    }
  }
}

/** Resolves/rejects with `promise`, or rejects with `signal.reason` as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Runs `worker` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
