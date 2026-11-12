import { describe, expect, it, vi } from 'vitest';
import { abortable, isRateLimitError, mapLimit, retryDelayMs, withRetry } from '../../src/context/retry';
import { instantSleep } from './helpers';

const httpError = (status: number, headers: Record<string, string> = {}, message = 'x') =>
  Object.assign(new Error(message), { status, response: { headers } });

describe('withRetry', () => {
  it('CTX-05 retries 5xx with exponential backoff up to 3 times', async () => {
    const { sleep, delays } = instantSleep();
    const fn = vi.fn().mockRejectedValue(httpError(502));
    await expect(withRetry(fn, { sleep, baseDelayMs: 100 })).rejects.toMatchObject({ status: 502 });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  it('CTX-05 returns the first success', async () => {
    const { sleep } = instantSleep();
    const fn = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce('ok');
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('CTX-05 does not retry 4xx, aborts or plain errors', async () => {
    const { sleep } = instantSleep();
    for (const err of [httpError(404), httpError(422), new Error('boom')]) {
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, { sleep })).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    const abortErr = Object.assign(new DOMException('aborted', 'AbortError'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(abortErr);
    await expect(withRetry(fn, { sleep })).rejects.toBe(abortErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('CTX-05 stops when the signal is aborted', async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockImplementation(async () => {
      ctrl.abort();
      throw httpError(503);
    });
    await expect(withRetry(fn, { sleep: async () => undefined }, ctrl.signal)).rejects.toMatchObject({
      status: 503,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('CTX-05 default sleep is abortable', async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockRejectedValue(httpError(500));
    const p = withRetry(fn, { baseDelayMs: 60_000, maxDelayMs: 120_000 }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('CTX-05 reports retries through onRetry without bodies', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce(1);
    await withRetry(fn, { sleep: async () => undefined, onRetry, baseDelayMs: 10 });
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 10, status: 500 });
  });
});

describe('retryDelayMs', () => {
  it('CTX-05 treats secondary rate limits (403 + retry-after / message) as retryable', () => {
    expect(retryDelayMs(httpError(403, { 'retry-after': '3' }), 0)).toBe(3_000);
    expect(
      retryDelayMs(httpError(403, {}, 'You have exceeded a secondary rate limit'), 1, { baseDelayMs: 50 }),
    ).toBe(100);
    expect(retryDelayMs(httpError(429), 0, { baseDelayMs: 7 })).toBe(7);
  });

  it('CTX-05 waits for x-ratelimit-reset on primary rate limits', () => {
    const now = () => 1_000_000;
    const err = httpError(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(1_000_000 / 1000 + 10),
    });
    expect(retryDelayMs(err, 0, { now })).toBe(11_000);
  });

  it('CTX-05 gives up when the server asks to wait longer than maxDelayMs', () => {
    expect(retryDelayMs(httpError(429, { 'retry-after': '3600' }), 0)).toBeNull();
  });

  it('CTX-05 does not retry a plain 403 permission error', () => {
    expect(retryDelayMs(httpError(403, {}, 'Resource not accessible by integration'), 0)).toBeNull();
    expect(isRateLimitError(httpError(403))).toBe(false);
    expect(isRateLimitError(httpError(404))).toBe(false);
    expect(isRateLimitError('nope')).toBe(false);
  });
});

describe('abortable / mapLimit', () => {
  it('rejects with the abort reason', async () => {
    const ctrl = new AbortController();
    const p = abortable(new Promise(() => undefined), ctrl.signal);
    ctrl.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    await expect(abortable(Promise.resolve(1), ctrl.signal)).rejects.toThrow('stop');
  });

  it('passes results and errors through', async () => {
    const signal = new AbortController().signal;
    await expect(abortable(Promise.resolve(2), signal)).resolves.toBe(2);
    await expect(abortable(Promise.reject(new Error('e')), signal)).rejects.toThrow('e');
  });

  it('CTX-03 limits concurrency and keeps order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBe(3);
    expect(await mapLimit([], 5, async () => 1)).toEqual([]);
  });
});
