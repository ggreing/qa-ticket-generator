/** SPEC v3 §2.2 / §5 — Slack notices for verify and plan runs (fakes only, no network). */
import type { KnownBlock } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import type { CaseSetSummary, CodeStatus, QaCase } from '../../src/core/cases';
import type { QtgConfig } from '../../src/core/config';
import type { DeliveryState, Language } from '../../src/core/contracts';
import { MAX_SECTION_CHARS } from '../../src/delivery/render/slack-blocks';
import type { SummaryCase, VerifySummaryInput } from '../../src/delivery/render/verify-summary';
import type { SlackChatClient } from '../../src/delivery/slack';
import { createSlackNotifier } from '../../src/delivery/slack-v3';
import { buildPlanNotice, buildVerifyNotice, MAX_NOTICE_ITEMS } from '../../src/delivery/slack-v3-blocks';
import { silentLogger } from '../helpers/fakes';

const ZWSP = String.fromCharCode(0x200b);
const SLACK_TILDE = String.fromCharCode(0x223c);
const TICKETS = 'https://github.com/acme/shop/issues';
const BOT: QtgConfig['slack'] = { mode: 'bot', token: 'xoxb-test-token', channel: 'C0123ABCD' };
const WEBHOOK_SECRET = '/services/T000/B000/secret-part';
const WEBHOOK: QtgConfig['slack'] = { mode: 'webhook', url: `https://hooks.slack.com${WEBHOOK_SECRET}` };

function qaCase(n: number, status: CodeStatus | null, overrides: Partial<SummaryCase> = {}): SummaryCase {
  const base: QaCase = {
    caseId: `SHOP-900-C${String(n).padStart(2, '0')}`,
    specRef: 'SHOP-900',
    lifecycle: 'active',
    title: `Wish list case ${n}`,
    acLabels: ['AC2'],
    technique: 'boundary',
    priority: 'P1',
    preconditions: [],
    testData: [],
    steps: ['Open the product'],
    expected: ['"Wish list is full" shown'],
    whyEasyToMiss: '',
    origin: 'spec',
  };
  return {
    ...base,
    url: `${TICKETS}/${100 + n}`,
    ...(status
      ? { codeStatus: { status, evidence: 'e', files: ['src/wishlist.ts'], sha: 'a1b2c3d4e5' } }
      : {}),
    ...overrides,
  };
}

function verifyInput(overrides: Partial<VerifySummaryInput> = {}): VerifySummaryInput {
  return {
    pr: {
      number: 42,
      title: 'Wish list',
      htmlUrl: 'https://github.com/acme/shop/pull/42',
      owner: 'acme',
      repo: 'shop',
    },
    spec: {
      ref: {
        source: 'jira',
        id: 'SHOP-900',
        raw: 'SHOP-900',
        url: 'https://acme.atlassian.net/browse/SHOP-900',
      },
      title: 'Wish list',
    },
    language: 'en',
    sha: 'a1b2c3d4e5f6',
    alignment: { status: 'misaligned', findings: [] },
    cases: [
      qaCase(1, 'implemented', { priority: 'P0' }),
      qaCase(2, 'missing', { priority: 'P2', title: 'Removed item can be added again' }),
      qaCase(3, 'contradicts', { priority: 'P1', title: '101st item rejected' }),
      qaCase(4, 'missing', { priority: 'P0', title: 'Signed-out visitor sent to sign-in' }),
      qaCase(5, 'unknown'),
      qaCase(6, null),
      qaCase(7, 'implemented', { lifecycle: 'obsolete' }),
    ],
    newCaseIds: ['SHOP-900-C06'],
    maxChecklist: 5,
    meta: {
      model: 'claude-opus-5-5',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.4321,
      durationMs: 1000,
      calls: 2,
      warnings: [],
    },
    ...overrides,
  };
}

function planSummary(overrides: Partial<CaseSetSummary> = {}): CaseSetSummary {
  return {
    specRef: {
      source: 'github',
      id: 'acme/shop#12',
      raw: 'acme/shop#12',
      url: 'https://github.com/acme/shop/issues/12',
    },
    specTitle: 'Coupon checkout',
    language: 'ko',
    cases: [],
    counts: { total: 12, byPriority: { P0: 3, P1: 6, P2: 3 }, obsolete: 2 },
    meta: { model: 'claude-opus-5-5', costUsd: 1.5, mode: 'plan' },
    ...overrides,
  };
}

const texts = (blocks: KnownBlock[]): string[] =>
  blocks.flatMap((b) => {
    if (b.type === 'section') return [b.text?.text ?? ''];
    if (b.type === 'context') return b.elements.map((e) => ('text' in e ? e.text : ''));
    return [];
  });
const all = (blocks: KnownBlock[]): string => texts(blocks).join('\n');
const actionUrls = (blocks: KnownBlock[]): string[] =>
  blocks.flatMap((b) =>
    b.type === 'actions' ? b.elements.map((e) => ('url' in e ? (e.url ?? '') : '')) : [],
  );

describe('SPEC v3 §2.2 buildVerifyNotice', () => {
  it('SPEC v3 §2.2 badge, PR and spec links, counts, then what the code contradicts or misses', () => {
    const { text, blocks } = buildVerifyNotice(verifyInput());
    const body = all(blocks);
    expect(body).toContain('🧪 *AI QA* — <https://github.com/acme/shop/pull/42|#42 Wish list>');
    expect(body).toContain('❌ *Misaligned* · `a1b2c3d`');
    expect(body).toContain('Spec: <https://acme.atlassian.net/browse/SHOP-900|SHOP-900> Wish list');
    expect(body).toContain('6 cases (P0 2 · P1 3 · P2 1) · Obsolete 1');
    expect(body).toContain(
      '*Code status*: ✅ Implemented 1 · ❌ Possibly missing 2 · ⛔ Contradicts the spec 1 · ❓ Cannot tell from code 1 · Not judged 1',
    );
    const attention = texts(blocks).find((t) => t.startsWith('*Missing or contradicting (3)*')) ?? '';
    expect(attention.split('\n').slice(1)).toEqual([
      `• ⛔ <${TICKETS}/103|SHOP-900-C03> *P1* 101st item rejected`,
      `• ❌ <${TICKETS}/104|SHOP-900-C04> *P0* Signed-out visitor sent to sign-in`,
      `• ❌ <${TICKETS}/102|SHOP-900-C02> *P2* Removed item can be added again`,
    ]);
    expect(body).toContain('➕ Added from the code (1)');
    expect(body).toContain('`a1b2c3d` · claude-opus-5-5 · ~$0.43');
    expect(actionUrls(blocks)).toEqual(['https://github.com/acme/shop/pull/42']);
    expect(text).toBe('AI QA — #42 Wish list: Misaligned, Missing or contradicting (3)');
  });

  it('SPEC v3 §2.2 lists the top cases and folds the rest into "and N more", within Slack limits', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      qaCase(i + 1, 'missing', { title: `Case ${i + 1} ${'x'.repeat(900)}` }),
    );
    const { blocks } = buildVerifyNotice(verifyInput({ cases: many, newCaseIds: [] }));
    const attention = texts(blocks).find((t) => t.startsWith('*Missing or contradicting (40)*')) ?? '';
    const items = attention.split('\n').filter((l) => l.startsWith('• '));
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(MAX_NOTICE_ITEMS);
    expect(attention).toContain(`… and ${40 - items.length} more`);
    expect(blocks.length).toBeLessThanOrEqual(50);
    for (const t of texts(blocks)) {
      expect(t.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
      // Lines are dropped whole: every link that opens also closes.
      expect(t.split('<').length).toBe(t.split('>').length);
    }
  });

  it('SPEC v3 §2.2 says so when nothing needs attention, and when the spec has no cases yet', () => {
    const ok = all(
      buildVerifyNotice(verifyInput({ cases: [qaCase(1, 'implemented')], newCaseIds: [] })).blocks,
    );
    expect(ok).toContain('✅ *No case is missing or contradicted in this change*');
    const none = buildVerifyNotice(verifyInput({ cases: [], newCaseIds: [] }));
    expect(all(none.blocks)).toContain('ℹ️ This spec has no QA cases yet. Run the plan phase first.');
    expect(all(none.blocks)).not.toContain('*Code status*');
  });

  it('SPEC v3 §2.2 DLV-06 model text is escaped; only plain https ticket links become links', () => {
    const { blocks, text } = buildVerifyNotice(
      verifyInput({
        pr: {
          number: 42,
          title: 'Fix <b>|1~2s</b> @channel',
          htmlUrl: 'https://github.com/acme/shop/pull/42',
          owner: 'acme',
          repo: 'shop',
        },
        cases: [
          qaCase(1, 'contradicts', {
            title: 'See https://evil.example/x and https://github.com/acme/shop/blob/main/a.ts',
            url: 'javascript:alert(1)',
          }),
          qaCase(2, 'missing', { url: 'http://github.com/acme/shop/issues/2' }),
          qaCase(3, 'missing', { caseId: 'SHOP-900-C03><!here>', url: undefined }),
        ],
      }),
    );
    const body = all(blocks);
    expect(body).toContain(
      `<https://github.com/acme/shop/pull/42|#42 Fix &lt;b&gt;¦1${SLACK_TILDE}2s&lt;/b&gt; @${ZWSP}channel>`,
    );
    expect(body).toContain('hxxps://evil.example/x');
    expect(body).toContain('https://github.com/acme/shop/blob/main/a.ts');
    expect(body).toContain('• ⛔ SHOP-900-C01 *P1*');
    expect(body).toContain('• ❌ SHOP-900-C02 *P1*');
    expect(body).toContain('• ❌ SHOP-900-C03here *P1*');
    expect(body).not.toMatch(/javascript:|<http:|<!here>/);
    expect(text).not.toContain('@channel');
  });

  it('SPEC v3 §2.2 speaks the configured language; dry runs are marked', () => {
    const labels: Record<Language, string> = {
      en: 'Contradicts the spec',
      ko: '기획과 상충',
      ja: '仕様と矛盾',
      'zh-CN': '与需求冲突',
    };
    for (const [language, label] of Object.entries(labels) as [Language, string][]) {
      expect(all(buildVerifyNotice(verifyInput({ language })).blocks)).toContain(label);
    }
    const dry = verifyInput();
    dry.meta = { ...dry.meta, dryRun: true };
    expect(all(buildVerifyNotice(dry).blocks)).toContain('· dry run');
  });
});

describe('SPEC v3 §5 buildPlanNotice', () => {
  it('SPEC v3 §5 spec title and link, counts with obsolete, changes and the list and spec buttons', () => {
    const { blocks, text } = buildPlanNotice(planSummary(), {
      listUrl: 'https://github.com/acme/shop/issues/12#issuecomment-1',
      changes: { created: 3, updated: 1, obsoleted: 2 },
    });
    const body = all(blocks);
    expect(body).toContain(
      '📋 *QA 케이스 생성* — <https://github.com/acme/shop/issues/12|acme/shop#12> Coupon checkout',
    );
    expect(body).toContain('케이스 12건 (P0 3 · P1 6 · P2 3) · 해당 없음 2');
    expect(body).toContain('이번 실행: 새 케이스 3 · 갱신 1 · 해당 없음 처리 2');
    expect(body).toContain('claude-opus-5-5 · ~$1.50');
    expect(actionUrls(blocks)).toEqual([
      'https://github.com/acme/shop/issues/12#issuecomment-1',
      'https://github.com/acme/shop/issues/12',
    ]);
    expect(text).toBe(
      'QA 케이스 생성 — acme/shop#12 Coupon checkout: 케이스 12건 (P0 3 · P1 6 · P2 3) · 해당 없음 2',
    );
  });

  it('SPEC v3 §5 four languages; no buttons and no link without a usable URL', () => {
    const obsolete: Record<Language, string> = {
      en: 'Obsolete 2',
      ko: '해당 없음 2',
      ja: '対象外 2',
      'zh-CN': '不再适用 2',
    };
    for (const [language, label] of Object.entries(obsolete) as [Language, string][]) {
      expect(all(buildPlanNotice(planSummary({ language })).blocks)).toContain(label);
    }
    const bare = buildPlanNotice(
      planSummary({
        specRef: { source: 'notion', id: '7c1e4b2a9d3f4e8a8b6c5d4e3f2a1b0c', raw: 'x' },
        counts: { total: 4, byPriority: { P0: 1, P1: 2, P2: 1 }, obsolete: 0 },
      }),
      { listUrl: 'http://example.com/list' },
    );
    expect(bare.blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(all(bare.blocks)).toContain('— 7c1e4b2a9d3f4e8a8b6c5d4e3f2a1b0c Coupon checkout');
    expect(all(bare.blocks)).not.toContain('해당 없음');
  });

  it('SPEC v3 §5 DLV-06 the spec title may link inside the spec repository only', () => {
    const body = all(
      buildPlanNotice(
        planSummary({ specTitle: 'See https://github.com/acme/shop/pull/3 and https://github.com/other/x' }),
      ).blocks,
    );
    expect(body).toContain('https://github.com/acme/shop/pull/3');
    expect(body).toContain('hxxps://github.com/other/x');
  });
});

type Chat = SlackChatClient['chat'];
const slackError = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });

function fakeSlack(overrides: Partial<Chat> = {}) {
  let n = 0;
  const chat = {
    postMessage: vi.fn(
      overrides.postMessage ??
        (async () => {
          n += 1;
          return { ok: true, channel: 'C0123ABCD', ts: `200.${n}` };
        }),
    ),
    update: vi.fn(overrides.update ?? (async () => ({ ok: true }))),
    delete: vi.fn(overrides.delete ?? (async () => ({ ok: true }))),
  };
  return { client: { chat } as SlackChatClient, chat };
}

const V2_STATE: DeliveryState = {
  v: 1,
  sha: 'abc1234',
  slack: { channel: 'C0123ABCD', ts: '100.1', replies: ['100.2', '100.3'] },
};

describe('SPEC v3 §2.2 §5 createSlackNotifier — bot mode', () => {
  it('SPEC v3 §2.2 returns null when Slack is off', () => {
    expect(createSlackNotifier({ mode: 'off' }, silentLogger())).toBeNull();
  });

  it('SPEC v3 §2.2 first verify run posts one message and returns its timestamp for the PR comment state', async () => {
    const { client, chat } = fakeSlack();
    const notifier = createSlackNotifier(BOT, silentLogger(), { client });
    const res = await notifier?.postVerify(verifyInput(), { v: 1 });
    expect(res).toEqual({
      ok: true,
      statePatch: { slack: { channel: 'C0123ABCD', ts: '200.1', replies: [] } },
    });
    expect(chat.postMessage).toHaveBeenCalledTimes(1);
    expect(chat.postMessage.mock.calls[0]?.[0]).toMatchObject({
      channel: 'C0123ABCD',
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(chat.postMessage.mock.calls[0]?.[0]).not.toHaveProperty('thread_ts');
  });

  it('SPEC v3 §2.2 a re-run edits the same message and removes replies an earlier v2 report left', async () => {
    const { client, chat } = fakeSlack({
      delete: async ({ ts }) => {
        if (ts === '100.3') throw slackError('ratelimited');
        return { ok: true };
      },
    });
    const res = await createSlackNotifier(BOT, silentLogger(), { client })?.postVerify(
      verifyInput(),
      V2_STATE,
    );
    expect(chat.update).toHaveBeenCalledTimes(1);
    expect(chat.update.mock.calls[0]?.[0]).toMatchObject({ channel: 'C0123ABCD', ts: '100.1' });
    expect(chat.postMessage).not.toHaveBeenCalled();
    expect(chat.delete.mock.calls.map((c) => c[0].ts)).toEqual(['100.2', '100.3']);
    // A reply that could not be removed stays in the state so the next run tries again.
    expect(res).toEqual({
      ok: true,
      statePatch: { slack: { channel: 'C0123ABCD', ts: '100.1', replies: ['100.3'] } },
    });
  });

  it('SPEC v3 §2.2 posts a new message when the old one is gone or the channel changed', async () => {
    const gone = fakeSlack({ update: async () => Promise.reject(slackError('message_not_found')) });
    const res = await createSlackNotifier(BOT, silentLogger(), { client: gone.client })?.postVerify(
      verifyInput(),
      V2_STATE,
    );
    expect(gone.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(res?.statePatch).toEqual({ slack: { channel: 'C0123ABCD', ts: '200.1', replies: [] } });

    const moved = fakeSlack();
    const other: DeliveryState = { v: 1, slack: { channel: 'C9999ZZZZ', ts: '100.1', replies: [] } };
    await createSlackNotifier(BOT, silentLogger(), { client: moved.client })?.postVerify(
      verifyInput(),
      other,
    );
    expect(moved.chat.update).not.toHaveBeenCalled();
    expect(moved.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('SPEC v3 §2.2 a failure is a warning, never a throw, and the log carries no content or token', async () => {
    const { client } = fakeSlack({
      postMessage: async () => Promise.reject(slackError('channel_not_found')),
    });
    const logger = silentLogger();
    const res = await createSlackNotifier(BOT, logger, { client })?.postVerify(verifyInput(), { v: 1 });
    expect(res).toEqual({
      ok: false,
      warning: { code: 'slack_failed', message: 'Slack notification failed; see the workflow log.' },
    });
    expect(logger.lines.join('\n')).toContain('channel_not_found');
    expect(logger.lines.join('\n')).not.toMatch(/xoxb|Wish list|SHOP-900/);
  });

  it('SPEC v3 §5 plan runs post a new message each time', async () => {
    const { client, chat } = fakeSlack();
    const notifier = createSlackNotifier(BOT, silentLogger(), { client });
    expect(await notifier?.postPlan(planSummary())).toEqual({ ok: true });
    expect(await notifier?.postPlan(planSummary())).toEqual({ ok: true });
    expect(chat.postMessage).toHaveBeenCalledTimes(2);
    expect(chat.update).not.toHaveBeenCalled();

    const broken = fakeSlack({ postMessage: async () => Promise.reject(slackError('not_in_channel')) });
    const res = await createSlackNotifier(BOT, silentLogger(), { client: broken.client })?.postPlan(
      planSummary(),
    );
    expect(res?.ok).toBe(false);
    expect(res?.warning?.code).toBe('slack_failed');
  });
});

describe('SPEC v3 §2.2 §5 createSlackNotifier — webhook mode', () => {
  const fakeFetch = (status = 200) =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status }));

  it('SPEC v3 §2.2 §5 posts each notice as JSON; no state', async () => {
    const fetch = fakeFetch();
    const notifier = createSlackNotifier(WEBHOOK, silentLogger(), {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await notifier?.postVerify(verifyInput(), V2_STATE)).toEqual({ ok: true });
    expect(await notifier?.postPlan(planSummary())).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`https://hooks.slack.com${WEBHOOK_SECRET}`);
    const body = JSON.parse(String(init?.body)) as { text: string; blocks: KnownBlock[] };
    expect(body.text).toContain('AI QA — #42');
    expect(body.blocks.length).toBeGreaterThan(2);
  });

  it('SPEC v3 §2.2 an HTTP error or a network failure is a warning; the URL is never logged', async () => {
    const logger = silentLogger();
    const http = createSlackNotifier(WEBHOOK, logger, {
      fetch: fakeFetch(500) as unknown as typeof globalThis.fetch,
    });
    expect((await http?.postPlan(planSummary()))?.warning?.code).toBe('slack_failed');
    const down = vi.fn(async () =>
      Promise.reject(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })),
    );
    const net = createSlackNotifier(WEBHOOK, logger, { fetch: down as unknown as typeof globalThis.fetch });
    expect((await net?.postVerify(verifyInput(), { v: 1 }))?.ok).toBe(false);
    const log = logger.lines.join('\n');
    expect(log).toContain('HTTP 500');
    expect(log).toContain('ENOTFOUND');
    expect(log).not.toContain('secret-part');
  });
});
