/** comment-store against a real Octokit wired to an in-memory fetch (pagination, status errors, retries). */
import { describe, expect, it } from 'vitest';
import { createPrCommentStore } from '../../src/delivery/comment-store';
import { REPORT_MARKER, serializeState } from '../../src/delivery/state';
import { fakeOctokit, type Handler, instantSleep, json, type RecordedRequest } from '../context/helpers';
import { fakePr } from '../helpers/fakes';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const LIST = '/repos/acme/shop/issues/42/comments';
const comment = (id: number, body: string) => ({
  id,
  body,
  html_url: `https://github.com/acme/shop/pull/42#issuecomment-${id}`,
  user: { login: 'github-actions[bot]', type: 'Bot' },
});
const marker = (id: number) =>
  comment(id, `${REPORT_MARKER}\n## report\n\n${serializeState({ v: 1, sha: SHA })}`);
const signature = (calls: RecordedRequest[]) => calls.map((c) => `${c.method} ${c.url.pathname}`);

function store(handler: Handler) {
  const { octokit, calls } = fakeOctokit(handler);
  const { sleep, delays } = instantSleep();
  return { store: createPrCommentStore(octokit, { retry: { sleep } }), calls, delays };
}

describe('createPrCommentStore over HTTP', () => {
  it('DLV-01 follows pagination to find the marker comment on a later page', async () => {
    const { store: s, calls } = store((req) => {
      if (req.url.searchParams.get('page') === '2') return json([comment(201, 'late'), marker(202)]);
      return json(
        Array.from({ length: 100 }, (_, i) => comment(i + 1, `comment ${i}`)),
        200,
        { link: `<https://api.github.com${LIST}?per_page=100&page=2>; rel="next"` },
      );
    });
    const loaded = await s.load(fakePr());
    expect(loaded).toEqual({ commentId: 202, state: { v: 1, sha: SHA }, warnings: [] });
    expect(calls.map((c) => c.url.searchParams.get('per_page'))).toEqual(['100', '100']);
  });

  it('DLV-01 retries a 5xx while listing comments, with exponential backoff', async () => {
    let n = 0;
    const {
      store: s,
      calls,
      delays,
    } = store(() => {
      n += 1;
      return n <= 2 ? json({ message: 'Bad Gateway' }, 502) : json([marker(7)]);
    });
    expect((await s.load(fakePr())).commentId).toBe(7);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('DLV-01 gives up after three retries and surfaces the error', async () => {
    const { store: s, calls, delays } = store(() => json({ message: 'Service Unavailable' }, 503));
    await expect(s.load(fakePr())).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it('DLV-01 honours retry-after on a secondary rate limit', async () => {
    let n = 0;
    const { store: s, delays } = store(() => {
      n += 1;
      return n === 1
        ? json({ message: 'You have exceeded a secondary rate limit.' }, 403, { 'retry-after': '7' })
        : json([]);
    });
    expect((await s.load(fakePr())).commentId).toBeNull();
    expect(delays).toEqual([7_000]);
  });

  it('DLV-01 retries the in-place update on a 5xx and sends the same body again', async () => {
    let n = 0;
    const {
      store: s,
      calls,
      delays,
    } = store((req) => {
      n += 1;
      return n === 1
        ? json({ message: 'oops' }, 500)
        : json({ ...comment(4, JSON.parse(req.body ?? '{}').body) });
    });
    const saved = await s.save(fakePr(), 4, '## report', { v: 1, sha: SHA });
    expect(saved).toEqual({ commentId: 4, url: 'https://github.com/acme/shop/pull/42#issuecomment-4' });
    expect(signature(calls)).toEqual([
      'PATCH /repos/acme/shop/issues/comments/4',
      'PATCH /repos/acme/shop/issues/comments/4',
    ]);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(delays).toEqual([1_000]);
  });

  it('DLV-01 does not create a second comment when a create that "failed" with 5xx actually went through', async () => {
    const { store: s, calls } = store((req) => {
      if (req.method === 'POST') return json({ message: 'timeout upstream' }, 502); // created server-side
      if (req.method === 'GET') return json([comment(1, 'LGTM'), marker(55)]);
      return json(comment(55, 'updated'));
    });
    const saved = await s.save(fakePr(), null, '## report', { v: 1 });
    expect(saved.commentId).toBe(55);
    expect(signature(calls)).toEqual([
      `POST ${LIST}`,
      `GET ${LIST}`,
      'PATCH /repos/acme/shop/issues/comments/55',
    ]);
  });

  it('DLV-01 retries the create when the failed attempt left nothing behind', async () => {
    let posts = 0;
    const { store: s, calls } = store((req) => {
      if (req.method === 'GET') return json([]);
      posts += 1;
      return posts === 1 ? json({ message: 'oops' }, 500) : json(comment(77, 'new'), 201);
    });
    expect((await s.save(fakePr(), null, 'body', { v: 1 })).commentId).toBe(77);
    expect(signature(calls)).toEqual([`POST ${LIST}`, `GET ${LIST}`, `POST ${LIST}`]);
  });

  it('DLV-01 creates a new comment when the old one was deleted (404), without retrying the 404', async () => {
    const {
      store: s,
      calls,
      delays,
    } = store((req) =>
      req.method === 'PATCH' ? json({ message: 'Not Found' }, 404) : json(comment(88, 'new'), 201),
    );
    expect((await s.save(fakePr(), 4, 'body', { v: 1 })).commentId).toBe(88);
    expect(signature(calls)).toEqual(['PATCH /repos/acme/shop/issues/comments/4', `POST ${LIST}`]);
    expect(delays).toEqual([]);
  });

  it('SPEC §10 does not retry a permission error (fork PR token) and lets the pipeline fall back', async () => {
    const {
      store: s,
      calls,
      delays,
    } = store(() => json({ message: 'Resource not accessible by integration' }, 403));
    await expect(s.save(fakePr(), null, 'body', { v: 1 })).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('SPEC §10 never retries a cancelled request, even though Octokit reports it with status 500', async () => {
    const {
      store: s,
      calls,
      delays,
    } = store(() => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const err = await s.load(fakePr()).then(
      () => null,
      (e: unknown) => e as { name?: string },
    );
    expect(err?.name).toBe('AbortError');
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});
