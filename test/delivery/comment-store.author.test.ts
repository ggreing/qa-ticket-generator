/** Marker comment author check: forged comments must never be loaded, edited or trusted (DLV-01, SPEC §11). */
import { describe, expect, it } from 'vitest';
import { createPrCommentStore } from '../../src/delivery/comment-store';
import { REPORT_MARKER, serializeState } from '../../src/delivery/state';
import { fakeOctokit, type Handler, instantSleep, json, type RecordedRequest } from '../context/helpers';
import { fakePr } from '../helpers/fakes';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const FORGED_SHA = 'f'.repeat(40);
const LIST = '/repos/acme/shop/issues/42/comments';
const BOT = 'github-actions[bot]';

const comment = (id: number, body: string, login = BOT) => ({
  id,
  body,
  created_at: new Date(Date.UTC(2026, 10, 12, 0, 0, id)).toISOString(),
  html_url: `https://github.com/acme/shop/pull/42#issuecomment-${id}`,
  user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
});
const marker = (id: number, login = BOT, sha = SHA) =>
  comment(id, `${REPORT_MARKER}\n## report\n\n${serializeState({ v: 1, sha })}`, login);
/** What an attacker with comment access would post: our marker plus a state of their choosing. */
const forged = (id: number, login = 'mallory') =>
  comment(
    id,
    `${REPORT_MARKER}\nfake report\n\n<!-- qtg-state:{"v":1,"sha":"${FORGED_SHA}","slack":{"channel":"C0EVIL000","ts":"1.1","replies":["1.2"]}} -->`,
    login,
  );
const denied = () => json({ message: 'Resource not accessible by integration' }, 403);
const isUser = (req: RecordedRequest) => req.url.pathname === '/user';
const signature = (calls: RecordedRequest[]) => calls.map((c) => `${c.method} ${c.url.pathname}`);

function store(handler: Handler, deps: { trustedAuthor?: string } = {}) {
  const { octokit, calls } = fakeOctokit(handler);
  const { sleep, delays } = instantSleep();
  const debug: string[] = [];
  const logger = { debug: (message: string) => void debug.push(message) };
  return {
    store: createPrCommentStore(octokit, { retry: { sleep }, logger, ...deps }),
    calls,
    delays,
    debug,
  };
}

describe('marker comment author check', () => {
  it('DLV-01 with the Actions token (GET /user → 403) trusts only github-actions[bot] and ignores forged marker comments', async () => {
    const { store: s, debug } = store((req) =>
      isUser(req) ? denied() : json([forged(1), marker(2), forged(3), comment(4, 'LGTM', 'mallory')]),
    );
    const loaded = await s.load(fakePr());
    expect(loaded).toEqual({ commentId: 2, state: { v: 1, sha: SHA }, warnings: [] });
    // OBS-01: the log has the count only, not who wrote the comments or what they contain.
    expect(debug).toEqual(['Ignored 2 report-marker comment(s) written by other authors.']);
  });

  it('DLV-01 when the only marker comment is forged, starts fresh and creates its own comment instead of editing the forgery', async () => {
    const { store: s, calls } = store((req) => {
      if (isUser(req)) return denied();
      if (req.method === 'GET') return json([forged(1)]);
      return json(comment(50, 'created'), 201);
    });
    const loaded = await s.load(fakePr());
    expect(loaded).toEqual({ commentId: null, state: { v: 1 }, warnings: [] });

    const saved = await s.save(fakePr(), loaded.commentId, '## report', loaded.state);
    expect(saved.commentId).toBe(50);
    expect(signature(calls)).toEqual(['GET /user', `GET ${LIST}`, `POST ${LIST}`]);
    expect(calls.at(-1)?.body).not.toContain(FORGED_SHA);
    expect(calls.at(-1)?.body).not.toContain('C0EVIL000');
  });

  it('DLV-01 with a user token trusts that user (case-insensitively), not the Actions bot', async () => {
    const { store: s, debug } = store((req) =>
      isUser(req)
        ? json({ login: 'Octo-Maintainer' })
        : json([marker(1, BOT, 'b'.repeat(40)), marker(2, 'octo-maintainer')]),
    );
    expect(await s.load(fakePr())).toEqual({ commentId: 2, state: { v: 1, sha: SHA }, warnings: [] });
    expect(debug).toEqual(['Ignored 1 report-marker comment(s) written by other authors.']);
  });

  it('DLV-01 treats GET /user → 404 like the Actions token', async () => {
    const { store: s } = store((req) =>
      isUser(req) ? json({ message: 'Not Found' }, 404) : json([marker(9)]),
    );
    expect((await s.load(fakePr())).commentId).toBe(9);
  });

  it('DLV-01 uses the most recent comment when the trusted author has several', async () => {
    const newest = { ...marker(10), created_at: '2026-11-13T09:00:00.000Z' };
    const { store: s, debug } = store((req) =>
      isUser(req)
        ? denied()
        : json([newest, marker(20, BOT, 'd'.repeat(40)), marker(30, BOT, 'c'.repeat(40))]),
    );
    expect(await s.load(fakePr())).toEqual({ commentId: 10, state: { v: 1, sha: SHA }, warnings: [] });
    expect(debug).toEqual([]);

    const sameTime = '2026-11-12T00:00:00.000Z';
    const tie = store((req) =>
      isUser(req)
        ? denied()
        : json([
            { ...marker(8), created_at: sameTime },
            { ...marker(7, BOT, 'e'.repeat(40)), created_at: sameTime },
          ]),
    );
    expect((await tie.store.load(fakePr())).commentId).toBe(8);
  });

  it('DLV-01 looks the identity up once and reuses it for later calls', async () => {
    const { store: s, calls } = store((req) => {
      if (isUser(req)) return denied();
      if (req.method === 'GET') return json([marker(5)]);
      return json(comment(5, 'updated'));
    });
    const loaded = await s.load(fakePr());
    await s.load(fakePr());
    await s.save(fakePr(), loaded.commentId, 'body', loaded.state);
    expect(signature(calls).filter((c) => c === 'GET /user')).toHaveLength(1);
  });

  it('DLV-01 the trustedAuthor option replaces the lookup (custom GitHub App tokens)', async () => {
    const { store: s, calls } = store(() => json([marker(1), marker(2, 'my-app[bot]')]), {
      trustedAuthor: ' My-App[bot] ',
    });
    expect((await s.load(fakePr())).commentId).toBe(2);
    expect(signature(calls)).toEqual([`GET ${LIST}`]);
  });

  it('DLV-01 does not guess an identity when the lookup fails for another reason, and looks again next time', async () => {
    let userCalls = 0;
    const {
      store: s,
      calls,
      delays,
    } = store((req) => {
      if (!isUser(req)) return json([marker(3)]);
      userCalls += 1;
      return userCalls === 1 ? json({ message: 'Bad credentials' }, 401) : denied();
    });
    await expect(s.load(fakePr())).rejects.toMatchObject({ status: 401 });
    expect(signature(calls)).toEqual(['GET /user']); // comments were not even listed
    expect(delays).toEqual([]);
    expect((await s.load(fakePr())).commentId).toBe(3); // the failure was not cached
  });

  it('DLV-01 a rate-limited identity lookup is retried rather than mistaken for the Actions token', async () => {
    let userCalls = 0;
    const { store: s, delays } = store((req) => {
      if (!isUser(req)) return json([marker(1, 'pat-owner')]);
      userCalls += 1;
      return userCalls === 1
        ? json({ message: 'You have exceeded a secondary rate limit.' }, 403, { 'retry-after': '3' })
        : json({ login: 'pat-owner' });
    });
    expect((await s.load(fakePr())).commentId).toBe(1);
    expect(delays).toEqual([3_000]);
  });

  it('DLV-01 a retried create also ignores forged marker comments when looking for its own leftover', async () => {
    let posts = 0;
    const { store: s, calls } = store((req) => {
      if (isUser(req)) return denied();
      if (req.method === 'GET') return json([forged(1)]);
      posts += 1;
      return posts === 1 ? json({ message: 'oops' }, 500) : json(comment(60, 'created'), 201);
    });
    expect((await s.save(fakePr(), null, 'body', { v: 1 })).commentId).toBe(60);
    expect(signature(calls)).toEqual([`POST ${LIST}`, 'GET /user', `GET ${LIST}`, `POST ${LIST}`]);
  });
});
