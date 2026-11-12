import { describe, expect, it, vi } from 'vitest';
import type { DeliveryState } from '../../src/core/contracts';
import type { Octokit } from '../../src/core/octokit';
import { ACTIONS_BOT_LOGIN, composeComment, createPrCommentStore } from '../../src/delivery/comment-store';
import { MAX_COMMENT_CHARS } from '../../src/delivery/render/markdown';
import { parseState, REPORT_MARKER, serializeState } from '../../src/delivery/state';
import { fakePr } from '../helpers/fakes';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const FULL_STATE: DeliveryState = {
  v: 1,
  sha: SHA,
  slack: {
    channel: 'C0123ABCD',
    ts: '1731400000.000100',
    replies: ['1731400000.000200', '1731400001.000300'],
  },
};

interface FakeComment {
  id: number;
  body?: string | null;
  /** Defaults to the Actions bot, which is what the store trusts when GET /user is denied. */
  login?: string;
}

function fakeOctokit(comments: FakeComment[] = [], updateError?: { status: number }) {
  const listComments = vi.fn();
  const paginate = vi.fn(async () =>
    comments.map(({ login, ...c }) => ({
      ...c,
      created_at: `2026-11-12T00:00:${String(c.id).padStart(2, '0')}Z`,
      user: { login: login ?? ACTIONS_BOT_LOGIN },
    })),
  );
  // GITHUB_TOKEN is an installation token: GET /user answers 403.
  const getAuthenticated = vi.fn(async (): Promise<{ data: { login: string } }> => {
    throw { status: 403, message: 'Resource not accessible by integration' };
  });
  const updateComment = vi.fn(async (args: { comment_id: number; body: string }) => {
    if (updateError) throw updateError;
    return {
      data: {
        id: args.comment_id,
        html_url: `https://github.com/acme/shop/pull/42#issuecomment-${args.comment_id}`,
      },
    };
  });
  const createComment = vi.fn(async (_args: { issue_number: number; body: string }) => ({
    data: { id: 999, html_url: 'https://github.com/acme/shop/pull/42#issuecomment-999' },
  }));
  const octokit = {
    paginate,
    rest: { issues: { listComments, updateComment, createComment }, users: { getAuthenticated } },
  } as unknown as Octokit;
  return { octokit, paginate, listComments, updateComment, createComment, getAuthenticated };
}

describe('delivery state (DLV-02)', () => {
  it('DLV-02 round-trips sha and Slack timestamps through the hidden comment block', () => {
    const block = serializeState(FULL_STATE);
    expect(block).toBe(
      `<!-- qtg-state:{"v":1,"sha":"${SHA}","slack":{"channel":"C0123ABCD","ts":"1731400000.000100","replies":["1731400000.000200","1731400001.000300"]}} -->`,
    );
    expect(parseState(`${REPORT_MARKER}\nbody\n\n${block}`)).toEqual({ state: FULL_STATE, corrupted: false });
    expect(parseState(serializeState({ v: 1 }))).toEqual({ state: { v: 1 }, corrupted: false });
  });

  it('DLV-02 escapes "-->" inside values so the state can never close its own comment', () => {
    const block = serializeState({ v: 1, sha: 'x--><script>alert(1)</script><!--' });
    expect(block.match(/-->/g)).toHaveLength(1);
    expect(block.endsWith(' -->')).toBe(true);
    expect(block).not.toContain('<script>');
    expect(JSON.parse(block.slice('<!-- qtg-state:'.length, -' -->'.length)).sha).toBe(
      'x--><script>alert(1)</script><!--',
    );
  });

  it('DLV-02 uses the last state block when the body contains several', () => {
    const body = `${serializeState({ v: 1, sha: 'b'.repeat(40) })}\ntext\n${serializeState({ v: 1, sha: SHA })}`;
    expect(parseState(body).state.sha).toBe(SHA);
  });

  it.each([
    ['no state block', 'just a comment'],
    ['invalid JSON', '<!-- qtg-state:{"v":1,"sha": -->'],
    ['truncated block', '<!-- qtg-state:{"v":1}'],
    ['wrong version', '<!-- qtg-state:{"v":2} -->'],
    ['an array', '<!-- qtg-state:[1,2] -->'],
    ['a non-hex sha', '<!-- qtg-state:{"v":1,"sha":"main; rm -rf"} -->'],
    [
      'a malformed Slack ts',
      '<!-- qtg-state:{"v":1,"slack":{"channel":"C0123ABCD","ts":"abc","replies":[]}} -->',
    ],
    [
      'a channel that is not an id',
      '<!-- qtg-state:{"v":1,"slack":{"channel":"#general","ts":"1.1","replies":[]}} -->',
    ],
    [
      'replies that are not timestamps',
      '<!-- qtg-state:{"v":1,"slack":{"channel":"C0123ABCD","ts":"1.1","replies":[5]}} -->',
    ],
  ])('DLV-02 treats %s as corrupted and starts from { v: 1 }', (_label, body) => {
    expect(parseState(body)).toEqual({ state: { v: 1 }, corrupted: true });
  });
});

describe('createPrCommentStore', () => {
  it('DLV-01 finds its own marker comment among the PR comments and reads its state', async () => {
    const comments: FakeComment[] = [
      { id: 1, body: 'LGTM' },
      { id: 2, body: null },
      { id: 3, body: `I quoted ${REPORT_MARKER} in the middle` },
      { id: 4, body: `\n${REPORT_MARKER}\n## report\n\n${serializeState(FULL_STATE)}` },
      { id: 5, body: `${REPORT_MARKER}\nforged by someone else`, login: 'mallory' },
    ];
    const { octokit, paginate, listComments } = fakeOctokit(comments);
    const loaded = await createPrCommentStore(octokit).load(fakePr());

    expect(loaded).toEqual({ commentId: 4, state: FULL_STATE, warnings: [] });
    expect(paginate).toHaveBeenCalledWith(listComments, {
      owner: 'acme',
      repo: 'shop',
      issue_number: 42,
      per_page: 100,
    });
  });

  it('DLV-01 returns no comment and a fresh state when the PR has no report yet', async () => {
    const { octokit } = fakeOctokit([{ id: 1, body: 'hello' }]);
    expect(await createPrCommentStore(octokit).load(fakePr())).toEqual({
      commentId: null,
      state: { v: 1 },
      warnings: [],
    });
  });

  it('DLV-02 keeps the comment id but resets a corrupted state with a state_corrupted warning', async () => {
    const { octokit } = fakeOctokit([{ id: 8, body: `${REPORT_MARKER}\nreport\n<!-- qtg-state:{oops} -->` }]);
    const loaded = await createPrCommentStore(octokit).load(fakePr());
    expect(loaded.commentId).toBe(8);
    expect(loaded.state).toEqual({ v: 1 });
    expect(loaded.warnings).toEqual([
      { code: 'state_corrupted', message: expect.stringContaining('started fresh') },
    ]);
  });

  it('DLV-01 edits the existing comment in place, wrapping the body with the marker and the state', async () => {
    const { octokit, updateComment, createComment } = fakeOctokit();
    const saved = await createPrCommentStore(octokit).save(fakePr(), 4, '## report', FULL_STATE);

    expect(saved).toEqual({ commentId: 4, url: 'https://github.com/acme/shop/pull/42#issuecomment-4' });
    expect(createComment).not.toHaveBeenCalled();
    const sent = updateComment.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ owner: 'acme', repo: 'shop', comment_id: 4 });
    expect(sent?.body).toBe(`${REPORT_MARKER}\n## report\n\n${serializeState(FULL_STATE)}`);
    expect(parseState(sent?.body ?? '')).toEqual({ state: FULL_STATE, corrupted: false });
  });

  it('DLV-01 creates the comment only when none exists', async () => {
    const { octokit, updateComment, createComment } = fakeOctokit();
    const saved = await createPrCommentStore(octokit).save(fakePr(), null, 'body', { v: 1 });
    expect(saved.commentId).toBe(999);
    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment.mock.calls[0]?.[0]).toMatchObject({ owner: 'acme', repo: 'shop', issue_number: 42 });
  });

  it('DLV-01 re-creates the comment when it was deleted between load and save, and surfaces other errors', async () => {
    const gone = fakeOctokit([], { status: 404 });
    expect((await createPrCommentStore(gone.octokit).save(fakePr(), 4, 'body', { v: 1 })).commentId).toBe(
      999,
    );
    expect(gone.createComment).toHaveBeenCalledTimes(1);

    const forbidden = fakeOctokit([], { status: 403 });
    await expect(createPrCommentStore(forbidden.octokit).save(fakePr(), 4, 'body', { v: 1 })).rejects.toEqual(
      { status: 403 },
    );
    expect(forbidden.createComment).not.toHaveBeenCalled();
  });

  it('DLV-03 never sends more than 65,536 characters, and keeps the marker and state intact', () => {
    const state = serializeState(FULL_STATE);
    const full = composeComment('x'.repeat(70_000), state);
    expect(full.length).toBe(MAX_COMMENT_CHARS);
    expect(full.startsWith(`${REPORT_MARKER}\n`)).toBe(true);
    expect(full.endsWith(`…\n\n${state}`)).toBe(true);
    expect(composeComment('short', state)).toBe(`${REPORT_MARKER}\nshort\n\n${state}`);
  });
});
