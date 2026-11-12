import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QtgConfig } from '../../src/core/config';
import type { DeliveryState, QaReport } from '../../src/core/contracts';
import {
  buildSummaryCard,
  buildThreadMessages,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_SECTION_CHARS,
} from '../../src/delivery/render/slack-blocks';
import { createSlackDeliverer, type SlackChatClient } from '../../src/delivery/slack';
import { fakeReport, silentLogger } from '../helpers/fakes';
import { finalReport, richReport } from './support';

const BOT: QtgConfig['slack'] = { mode: 'bot', token: 'xoxb-test-token', channel: 'C0123ABCD' };
const WEBHOOK_PATH = '/services/T000/B000/secret-part';
const WEBHOOK: QtgConfig['slack'] = { mode: 'webhook', url: `https://hooks.slack.com${WEBHOOK_PATH}` };
const PREVIOUS: DeliveryState = {
  v: 1,
  slack: { channel: 'C0123ABCD', ts: '100.1', replies: ['100.2', '100.3'] },
};
const ZWSP = '​';

type Scenario = QaReport['scenarios'][number];
const scenario = (overrides: Partial<Scenario>): Scenario => ({
  ...(fakeReport().scenarios[0] as Scenario),
  ...overrides,
});
const slackError = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });

type Chat = SlackChatClient['chat'];

function fakeSlack(overrides: Partial<Chat> = {}) {
  let n = 0;
  const postMessage: Chat['postMessage'] = async () => {
    n += 1;
    return { ok: true, channel: 'C0123ABCD', ts: `200.${n}` };
  };
  const update: Chat['update'] = async () => ({ ok: true });
  const remove: Chat['delete'] = async () => ({ ok: true });
  const chat = {
    postMessage: vi.fn(overrides.postMessage ?? postMessage),
    update: vi.fn(overrides.update ?? update),
    delete: vi.fn(overrides.delete ?? remove),
  };
  const client: SlackChatClient = { chat };
  return { client, chat };
}

const json = (blocks: unknown) => JSON.stringify(blocks);

describe('createSlackDeliverer — off', () => {
  it('DLV-04 returns null when Slack is not configured', () => {
    expect(createSlackDeliverer({ mode: 'off' }, silentLogger())).toBeNull();
  });
});

describe('createSlackDeliverer — bot mode (DLV-04)', () => {
  it('DLV-04 first run posts the summary card, then the details in its thread, and returns the timestamps', async () => {
    const { client, chat } = fakeSlack();
    const logger = silentLogger();
    const slack = createSlackDeliverer(BOT, logger, { client });
    const res = await slack?.deliver(finalReport(), { v: 1 });

    expect(slack?.channel).toBe('slack');
    expect(chat.update).not.toHaveBeenCalled();
    expect(chat.delete).not.toHaveBeenCalled();
    expect(chat.postMessage).toHaveBeenCalledTimes(2);
    const [parent, reply] = chat.postMessage.mock.calls.map((c) => c[0]);
    expect(parent).toMatchObject({ channel: 'C0123ABCD', unfurl_links: false, unfurl_media: false });
    expect(parent).not.toHaveProperty('thread_ts');
    expect(reply).toMatchObject({ channel: 'C0123ABCD', thread_ts: '200.1' });
    expect(res).toEqual({
      channel: 'slack',
      ok: true,
      statePatch: { slack: { channel: 'C0123ABCD', ts: '200.1', replies: ['200.2'] } },
    });
    // OBS-01: the log carries counts, never message content or the token.
    expect(logger.lines).toEqual([
      'info: Slack: parent posted, 1 thread message(s) posted, 0 old one(s) removed.',
    ]);
  });

  it('DLV-04 re-run edits the parent with chat.update, deletes the old replies and posts the details again', async () => {
    const { client, chat } = fakeSlack();
    const res = await createSlackDeliverer(BOT, silentLogger(), { client })?.deliver(finalReport(), PREVIOUS);

    expect(chat.update).toHaveBeenCalledTimes(1);
    expect(chat.update.mock.calls[0]?.[0]).toMatchObject({ channel: 'C0123ABCD', ts: '100.1' });
    expect(chat.delete.mock.calls.map((c) => c[0])).toEqual([
      { channel: 'C0123ABCD', ts: '100.2' },
      { channel: 'C0123ABCD', ts: '100.3' },
    ]);
    expect(chat.postMessage).toHaveBeenCalledTimes(1);
    expect(chat.postMessage.mock.calls[0]?.[0]).toMatchObject({ thread_ts: '100.1' });
    expect(res?.statePatch).toEqual({ slack: { channel: 'C0123ABCD', ts: '100.1', replies: ['200.1'] } });
  });

  it('DLV-04 posts a new parent when the old one can no longer be updated', async () => {
    const { client, chat } = fakeSlack({
      update: vi.fn(async () => Promise.reject(slackError('message_not_found'))),
    });
    const res = await createSlackDeliverer(BOT, silentLogger(), { client })?.deliver(finalReport(), PREVIOUS);
    expect(chat.postMessage).toHaveBeenCalledTimes(2);
    expect(chat.postMessage.mock.calls[0]?.[0]).not.toHaveProperty('thread_ts');
    expect(res?.ok).toBe(true);
    expect(res?.statePatch).toEqual({ slack: { channel: 'C0123ABCD', ts: '200.1', replies: ['200.2'] } });
  });

  it('DLV-04 keeps a reply it could not delete in the state so the next run retries, but forgets ones already gone', async () => {
    const remove = vi.fn(async (args: { ts: string }) => {
      if (args.ts === '100.2') throw slackError('message_not_found');
      throw slackError('ratelimited');
    });
    const { client } = fakeSlack({ delete: remove });
    const res = await createSlackDeliverer(BOT, silentLogger(), { client })?.deliver(finalReport(), PREVIOUS);
    expect(res?.statePatch?.slack?.replies).toEqual(['100.3', '200.1']);
  });

  it('DLV-04 ignores state from another channel and starts a new message there', async () => {
    const { client, chat } = fakeSlack();
    const other: QtgConfig['slack'] = { mode: 'bot', token: 't', channel: 'C0999ZZZZ' };
    await createSlackDeliverer(other, silentLogger(), { client })?.deliver(finalReport(), PREVIOUS);
    expect(chat.update).not.toHaveBeenCalled();
    expect(chat.delete).not.toHaveBeenCalled();
    expect(chat.postMessage.mock.calls[0]?.[0].channel).toBe('C0999ZZZZ');

    // A channel given by name cannot be compared with the stored id, so the state is trusted.
    const named = fakeSlack();
    await createSlackDeliverer({ mode: 'bot', token: 't', channel: '#qa' }, silentLogger(), {
      client: named.client,
    })?.deliver(finalReport(), PREVIOUS);
    expect(named.chat.update).toHaveBeenCalledTimes(1);
  });

  it('DLV-08 reports a failure as a warning without throwing, keeping what was posted for the next run', async () => {
    let n = 0;
    const post = vi.fn(async () => {
      n += 1;
      if (n === 2) throw slackError('channel_not_found');
      return { ok: true, channel: 'C0123ABCD', ts: `300.${n}` };
    });
    const logger = silentLogger();
    const res = await createSlackDeliverer(BOT, logger, {
      client: fakeSlack({ postMessage: post }).client,
    })?.deliver(finalReport(), { v: 1 });
    expect(res).toEqual({
      channel: 'slack',
      ok: false,
      statePatch: { slack: { channel: 'C0123ABCD', ts: '300.1', replies: [] } },
      warning: { code: 'slack_failed', message: 'Slack delivery failed; see the workflow log.' },
    });
    expect(logger.lines).toEqual(['warn: Slack delivery failed (channel_not_found).']);

    const dead = fakeSlack({ postMessage: vi.fn(async () => ({ ok: true })) });
    const none = await createSlackDeliverer(BOT, silentLogger(), { client: dead.client })?.deliver(
      finalReport(),
      { v: 1 },
    );
    expect(none).toMatchObject({ ok: false, statePatch: undefined });
  });

  it('DLV-04 on a failed run only refreshes an existing parent, and posts nothing when there is none', async () => {
    const failedRun = finalReport({
      status: 'error',
      report: null,
      error: { code: 'llm_auth', message: 'Check the key.' },
    });
    const fresh = fakeSlack();
    expect(
      await createSlackDeliverer(BOT, silentLogger(), { client: fresh.client })?.deliver(failedRun, { v: 1 }),
    ).toEqual({
      channel: 'slack',
      ok: true,
    });
    expect(fresh.chat.postMessage).not.toHaveBeenCalled();

    const existing = fakeSlack();
    const res = await createSlackDeliverer(BOT, silentLogger(), { client: existing.client })?.deliver(
      failedRun,
      PREVIOUS,
    );
    expect(res).toEqual({ channel: 'slack', ok: true }); // no statePatch: the thread is left as it was
    expect(existing.chat.update).toHaveBeenCalledTimes(1);
    expect(json(existing.chat.update.mock.calls[0]?.[0].blocks)).toContain('Run failed');
    expect(existing.chat.delete).not.toHaveBeenCalled();
    expect(existing.chat.postMessage).not.toHaveBeenCalled();

    const broken = fakeSlack({ update: vi.fn(async () => Promise.reject(slackError('is_archived'))) });
    const bad = await createSlackDeliverer(BOT, silentLogger(), { client: broken.client })?.deliver(
      failedRun,
      PREVIOUS,
    );
    expect(bad).toMatchObject({ ok: false, warning: { code: 'slack_failed' } });
  });

  it('DLV-04 builds a real WebClient from the bot token when no client is injected', () => {
    expect(createSlackDeliverer(BOT, silentLogger())?.channel).toBe('slack');
  });
});

describe('Slack blocks (SPEC §4.6)', () => {
  it('SPEC §4.6 summary card shows PR, alignment badge, scenario counts, top three risks and both buttons', () => {
    const report = richReport({
      risks: [
        { title: 'low one', severity: 'low', description: '', files: [] },
        { title: 'high one', severity: 'high', description: '', files: [] },
        { title: 'medium one', severity: 'medium', description: '', files: [] },
        { title: 'another low', severity: 'low', description: '', files: [] },
      ],
    });
    const card = buildSummaryCard(finalReport({ report }), 'https://github.com/acme/shop/actions/runs/1');
    const text = json(card.blocks);

    expect(text).toContain('<https://github.com/acme/shop/pull/42|#42 Apply coupon at checkout>');
    expect(text).toContain('*PRD alignment*\\n⚠️ Partial');
    expect(text).toContain('*Scenarios*\\n3 (P0 1 · P1 1 · P2 1)');
    expect(text).toContain('*Top risks*\\n• 🔴 high one\\n• 🟠 medium one\\n• 🟡 low one');
    expect(text).not.toContain('another low');
    const actions = card.blocks.find((b) => b.type === 'actions');
    expect(actions).toMatchObject({
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open PR' },
          url: 'https://github.com/acme/shop/pull/42',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View full report' },
          url: 'https://github.com/acme/shop/actions/runs/1',
        },
      ],
    });
    expect(card.text).toBe(
      'AI QA Scenarios — #42 Apply coupon at checkout: PRD alignment Partial, 3 Scenarios',
    );
  });

  it('SPEC §4.6 the full-report button defaults to the PR and can be overridden', async () => {
    const a = fakeSlack();
    await createSlackDeliverer(BOT, silentLogger(), { client: a.client })?.deliver(finalReport(), { v: 1 });
    expect(json(a.chat.postMessage.mock.calls[0]?.[0].blocks)).toContain(
      '"action_id":"qtg_view_report","text":{"type":"plain_text","text":"View full report"},"url":"https://github.com/acme/shop/pull/42"',
    );

    const b = fakeSlack();
    await createSlackDeliverer(BOT, silentLogger(), {
      client: b.client,
      fullReportUrl: () => 'https://github.com/acme/shop/actions/runs/7',
    })?.deliver(finalReport(), { v: 1 });
    expect(json(b.chat.postMessage.mock.calls[0]?.[0].blocks)).toContain(
      '"url":"https://github.com/acme/shop/actions/runs/7"',
    );
  });

  it('DLV-09 summary card carries the translated no-PRD notice and localized labels', () => {
    const report = richReport({ prdAlignment: { status: 'no_prd', findings: [] }, risks: [], summary: ' ' });
    const card = buildSummaryCard(
      finalReport({ report, language: 'ko' }, { prdSources: [] }),
      'https://github.com/acme/shop/pull/42',
    );
    const text = json(card.blocks);
    expect(text).toContain('연결된 PRD가 없습니다');
    expect(text).toContain('*PRD 정합성*\\n➖ PRD 없음');
    expect(text).toContain('"text":"PR 열기"');
    expect(text).not.toContain('주요 리스크');
  });

  it('SPEC §4.6 status cards for skipped runs', () => {
    const noFiles = buildSummaryCard(
      finalReport({ status: 'skipped', report: null, skipReason: 'no_files' }),
      'u',
    );
    expect(json(noFiles.blocks)).toContain('No logic changes to analyze');
    const other = buildSummaryCard(
      finalReport({ status: 'skipped', report: null, skipReason: 'closed' }, { calls: 0 }),
      'u',
    );
    expect(json(other.blocks)).toContain('ℹ️ Analysis was skipped');
    expect(json(other.blocks)).not.toContain('~$');
    const bare = buildSummaryCard(finalReport({ status: 'error', report: null }), 'u');
    expect(json(bare.blocks)).toContain('❌ *Run failed*');
  });

  it('DLV-04 thread lists open requirements, then one section per scenario with Given/When/Then', () => {
    const [message, ...rest] = buildThreadMessages(finalReport());
    expect(rest).toEqual([]);
    expect(message?.blocks).toHaveLength(4);
    const text = json(message?.blocks);
    expect(text).toContain(
      '*Requirements needing attention*\\n• *missing* — AC3: expired coupons are rejected: No expiry comparison in coupon.ts',
    );
    expect(text).not.toContain('AC1: a coupon can be applied once: CouponService');
    expect(text).toContain(
      '*[P1][Negative] S-02 · Apply the same coupon twice in parallel*\\n*Given* a coupon that was never used\\n*And* two checkout tabs',
    );
    expect(text).toContain('_Related_: AC3: expired coupons are rejected · `src/coupon.ts`');
    expect(message?.text).toBe('Scenarios (1/1)');
    expect(buildThreadMessages(finalReport({ status: 'error', report: null }))).toEqual([]);
    const empty = richReport({ scenarios: [], prdAlignment: { status: 'aligned', findings: [] } });
    expect(buildThreadMessages(finalReport({ report: empty }))).toEqual([]);
  });

  it('DLV-04 splits the thread into messages of at most 45 blocks and keeps each section under 3000 characters', async () => {
    const scenarios = Array.from({ length: 100 }, (_, i) =>
      scenario({ id: `S-${i + 1}`, title: `scenario ${i + 1}`, given: ['g'.repeat(5_000)] }),
    );
    const final = finalReport({ report: richReport({ scenarios }) });
    const messages = buildThreadMessages(final);
    expect(messages.map((m) => m.blocks.length)).toEqual([45, 45, 11]);
    expect(messages.map((m) => m.text)).toEqual(['Scenarios (1/3)', 'Scenarios (2/3)', 'Scenarios (3/3)']);
    expect(MAX_BLOCKS_PER_MESSAGE).toBe(45);
    for (const m of messages) {
      for (const block of m.blocks) {
        if (block.type === 'section' && block.text)
          expect(block.text.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
      }
    }
    const { client, chat } = fakeSlack();
    const res = await createSlackDeliverer(BOT, silentLogger(), { client })?.deliver(final, { v: 1 });
    expect(chat.postMessage).toHaveBeenCalledTimes(4);
    expect(res?.statePatch?.slack?.replies).toEqual(['200.2', '200.3', '200.4']);
  });

  it('DLV-06 neutralizes mentions, special sequences and foreign links coming from the PR title and the model', () => {
    const hostile =
      '<!channel> @here <@U012ABCDEF> <https://evil.example|click> https://evil.example/x & more';
    const report = richReport({
      summary: hostile,
      scenarios: [
        scenario({
          title: hostile,
          given: [hostile],
          relatedRequirements: [hostile],
          relatedFiles: ['a`b.ts'],
        }),
      ],
      risks: [{ title: hostile, severity: 'high', description: hostile, files: [] }],
      prdAlignment: {
        status: 'partial',
        findings: [{ requirement: hostile, source: 's', status: 'missing', evidence: hostile, files: [] }],
      },
    });
    const final = finalReport({ report });
    final.pr.title = `${hostile} | pipe`;
    const all = json([
      buildSummaryCard(final, final.pr.htmlUrl).blocks,
      buildThreadMessages(final).map((m) => m.blocks),
    ]);

    expect(all).not.toContain('<!channel>');
    expect(all).not.toContain('<@U012ABCDEF>');
    expect(all).not.toContain('@here');
    expect(all).toContain(`@${ZWSP}here`);
    expect(all).not.toMatch(/https?:\/\/evil/);
    expect(all).toContain('hxxps://evil.example/x &amp; more');
    // The only Slack link is the PR link built by the renderer, and the title cannot break out of it.
    expect(all.match(/<https:[^>]*>/g)).toEqual([
      expect.stringMatching(/^<https:\/\/github\.com\/acme\/shop\/pull\/42\|#42 /),
    ]);
    expect(all).toContain("`a'b.ts`");
  });
});

describe('createSlackDeliverer — webhook mode (DLV-05)', () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  it('DLV-05 posts one JSON request to the webhook URL and reports success without any state', async () => {
    agent
      .get('https://hooks.slack.com')
      .intercept({ path: WEBHOOK_PATH, method: 'POST', headers: { 'content-type': 'application/json' } })
      .reply(200, 'ok');
    const logger = silentLogger();
    const res = await createSlackDeliverer(WEBHOOK, logger)?.deliver(finalReport(), PREVIOUS);

    expect(res).toEqual({ channel: 'slack', ok: true });
    agent.assertNoPendingInterceptors();
    expect(logger.lines).toEqual(['info: Slack: summary card sent through the webhook.']);
  });

  it('DLV-08 turns a non-2xx webhook response into a warning and never logs the webhook URL', async () => {
    agent
      .get('https://hooks.slack.com')
      .intercept({ path: WEBHOOK_PATH, method: 'POST' })
      .reply(404, 'no_service');
    const logger = silentLogger();
    const res = await createSlackDeliverer(WEBHOOK, logger)?.deliver(finalReport(), { v: 1 });
    expect(res).toEqual({
      channel: 'slack',
      ok: false,
      statePatch: undefined,
      warning: { code: 'slack_failed', message: 'Slack delivery failed; see the workflow log.' },
    });
    expect(logger.lines).toEqual(['warn: Slack webhook responded with HTTP 404.']);
  });

  it('DLV-08 turns a network failure into a warning and never logs the webhook URL', async () => {
    agent
      .get('https://hooks.slack.com')
      .intercept({ path: WEBHOOK_PATH, method: 'POST' })
      .replyWithError(new Error('getaddrinfo ENOTFOUND'));
    const logger = silentLogger();
    const res = await createSlackDeliverer(WEBHOOK, logger)?.deliver(finalReport(), { v: 1 });
    expect(res?.ok).toBe(false);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines.join()).not.toContain('secret-part');
    expect(logger.lines.join()).not.toContain('hooks.slack.com');
  });

  it('DLV-05 sends only the summary card: no thread, no scenario details', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: { method: string; body: string }) => new Response('ok', { status: 200 }),
    );
    const res = await createSlackDeliverer(WEBHOOK, silentLogger(), {
      fetch: fetchMock as unknown as typeof fetch,
    })?.deliver(finalReport(), { v: 1 });

    expect(res?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`https://hooks.slack.com${WEBHOOK_PATH}`);
    expect(init?.method).toBe('POST');
    const sent = JSON.parse(init?.body ?? '{}') as { text: string; blocks: { type: string }[] };
    expect(sent.text).toContain('#42 Apply coupon at checkout');
    expect(sent.blocks.map((b) => b.type)).toEqual([
      'section',
      'section',
      'section',
      'section',
      'actions',
      'context',
    ]);
    expect(sent).not.toHaveProperty('thread_ts');
    expect(JSON.stringify(sent)).not.toContain('*Given*');
  });
});
