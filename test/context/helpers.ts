/** Test helpers for src/context (no network: every request goes through an in-memory handler). */
import { readFileSync } from 'node:fs';
import { getOctokit } from '@actions/github';
import type { Octokit } from '../../src/core/octokit';

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Handler = (req: RecordedRequest) => Response | Promise<Response>;

/** A `fetch` replacement that records requests and answers from `handler`. Honours `signal`. */
export function fakeFetch(handler: Handler) {
  const calls: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    init.signal?.throwIfAborted();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req: RecordedRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: new URL(String(input instanceof Request ? input.url : input)),
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(req);
    const res = handler(req);
    if (!init.signal) return res;
    const signal = init.signal;
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      Promise.resolve(res).then(resolve, reject);
    });
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Octokit wired to a fake fetch, as recommended for tests (`request.fetch` injection). */
export function fakeOctokit(handler: Handler): { octokit: Octokit; calls: RecordedRequest[] } {
  const { fetch, calls } = fakeFetch(handler);
  return { octokit: getOctokit('test-token', { request: { fetch } }), calls };
}

/** Never-resolving response, for timeout tests. */
export const hang = (): Promise<Response> => new Promise<Response>(() => undefined);

const FIXTURES = new URL('../../fixtures/context/', import.meta.url);

/** Reads a synthetic JSON fixture from `fixtures/context/`. */
export function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8')) as T;
}

/** Sleep stub for retry tests: records delays, resolves immediately. */
export function instantSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}
