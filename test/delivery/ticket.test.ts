import { describe, expect, it } from 'vitest';
import { renderPrComment } from '../../src/delivery/render/markdown';
import { buildSummaryCard, buildThreadMessages } from '../../src/delivery/render/slack-blocks';
import {
  expectedSummary,
  firstSentence,
  lead,
  MAX_EVIDENCE_CHARS,
  MAX_REQUIREMENT_CHARS,
  requirementLabel,
  shorten,
  ticketTag,
} from '../../src/delivery/render/ticket';
import { finalReport, richReport } from './support';

type Scenario = ReturnType<typeof richReport>['scenarios'][number];
const base = richReport().scenarios[0] as Scenario;
const scenario = (overrides: Partial<Scenario>): Scenario => ({ ...base, ...overrides });

// Text the model actually wrote in eval round 0 (case rbac-export-role).
const AC1 = 'AC1: Only users with the role admin can export user data. Every other role gets HTTP 403.';
const AC1_EVIDENCE =
  'app/admin/export.py defines EXPORT_ROLES = {"admin", "manager"}, and export_users raises Forbidden only when actor.role is not in that set. The manager role can therefore still export, which AC1 forbids. Roles support and viewer are rejected as required.';
const AC3 = 'AC3: A user can run at most 5 exports per hour. Further requests get HTTP 429.';
const AC3_EVIDENCE =
  'Neither export_users in app/admin/export.py nor the route registration in app/admin/routes.py contains any rate limiting, counter or 429 response.';

describe('requirement labels in ticket titles (M3.5 round 0 finding)', () => {
  it('M3.5 finds the label however the requirement was written: bare, prefixed, inside a sentence', () => {
    expect(requirementLabel('AC1')).toBe('AC1'); // what the model wrote in round 0; used to show no tag at all
    expect(requirementLabel(' ac 2 ')).toBe('ac2');
    expect(requirementLabel(AC1)).toBe('AC1');
    expect(requirementLabel('Only admins can export user data (AC1), every other role gets 403')).toBe('AC1');
    expect(requirementLabel('The export limit from ac-3 applies')).toBe('AC3');
    expect(requirementLabel('REQ-12 - must log')).toBe('REQ-12');
    expect(requirementLabel('FR 1.2) exports')).toBe('FR1.2');
    expect(requirementLabel('AC10: something')).toBe('AC10');
  });

  it('M3.5 falls back to a tracker key or an issue reference, and to nothing for plain prose', () => {
    expect(requirementLabel('PAYMENTS-1432 refunds are idempotent')).toBe('PAYMENTS-1432');
    expect(requirementLabel('colinhacks/zod#6659')).toBe('#6659');
    expect(requirementLabel('Issue #4095: use opts.Cursor for ListHookDeliveriesIter pagination')).toBe(
      '#4095',
    );
    expect(requirementLabel('google/gson#3113 reproducer row 1 (lone high surrogate in value)')).toBe(
      '#3113',
    );
    expect(requirementLabel('Rounding')).toBeNull();
    expect(requirementLabel('Expired coupons are rejected')).toBeNull();
    expect(requirementLabel('returns HTTP 403 for 5 roles')).toBeNull();
    expect(requirementLabel('')).toBeNull();
  });

  it('M3.5 the title tag lists each label once, at most three, and is just the priority when there is none', () => {
    expect(ticketTag(scenario({ priority: 'P0', relatedRequirements: ['AC1', 'AC2'] }))).toBe(
      'P0 · AC1, AC2',
    );
    expect(ticketTag(scenario({ priority: 'P0', relatedRequirements: [AC1, 'AC1', 'covers AC1 too'] }))).toBe(
      'P0 · AC1',
    );
    expect(
      ticketTag(
        scenario({ priority: 'P1', relatedRequirements: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'Rounding'] }),
      ),
    ).toBe('P1 · AC1, AC2, AC3 +2');
    expect(ticketTag(scenario({ priority: 'P2', relatedRequirements: ['Rounding'] }))).toBe('P2');
    expect(ticketTag(scenario({ priority: 'P2', relatedRequirements: [] }))).toBe('P2');
  });
});

describe('shortening text for the top section (M3.5 round 0 finding)', () => {
  it('M3.5 firstSentence stops at the first sentence end, not at a dot in a file name, number, abbreviation or code', () => {
    expect(firstSentence(AC1_EVIDENCE)).toBe(
      'app/admin/export.py defines EXPORT_ROLES = {"admin", "manager"}, and export_users raises Forbidden only when actor.role is not in that set.',
    );
    expect(firstSentence(AC3_EVIDENCE)).toBe(AC3_EVIDENCE);
    expect(firstSentence('Limits are low, e.g. 5 per hour. More text.')).toBe(
      'Limits are low, e.g. 5 per hour.',
    );
    expect(firstSentence('The cap is 2.5 MB per file. Larger files fail.')).toBe(
      'The cap is 2.5 MB per file.',
    );
    expect(firstSentence('`a. b` is compared in `x.ts`. Next.')).toBe('`a. b` is compared in `x.ts`.');
    expect(firstSentence('Is it checked? No.')).toBe('Is it checked?');
    expect(firstSentence('one line\nwithout an end')).toBe('one line without an end');
    expect(firstSentence('')).toBe('');
  });

  it('M3.5 firstSentence handles Korean, Japanese and Chinese sentence ends', () => {
    expect(firstSentence('만료 비교가 coupon.ts에 없습니다. 따라서 AC3은 구현되지 않았습니다.')).toBe(
      '만료 비교가 coupon.ts에 없습니다.',
    );
    expect(firstSentence('coupon.ts に期限の比較がありません。そのため AC3 は未実装です。')).toBe(
      'coupon.ts に期限の比較がありません。',
    );
    expect(firstSentence('coupon.ts 中没有过期比较。因此 AC3 未实现。')).toBe('coupon.ts 中没有过期比较。');
    expect(firstSentence('끝이 하나뿐인 문장입니다.')).toBe('끝이 하나뿐인 문장입니다.');
  });

  it('M3.5 shorten cuts at a word boundary, never inside a code span, and leaves short text alone', () => {
    expect(shorten('short text', 60)).toBe('short text');
    const cut = shorten(
      'Neither export_users nor the route registration contains any rate limiting at all',
      60,
    );
    expect(cut).toBe('Neither export_users nor the route registration contains…');
    expect(cut.length).toBeLessThanOrEqual(60);
    // A span that would be cut in half is dropped whole.
    expect(shorten('Nothing notifies `notice.created_by` when the send job fails here', 30)).toBe(
      'Nothing notifies…',
    );
    expect(shorten('rejects when `a >= b` and also when `c.d` is unset or empty here', 40)).toBe(
      'rejects when `a >= b` and also when…',
    );
    // No spaces to cut at (CJK): a hard cut that still respects the limit.
    const cjk = shorten('가'.repeat(100), 20);
    expect(cjk).toBe(`${'가'.repeat(19)}…`);
    expect(shorten('trailing punctuation, — and more words follow after this point', 23)).toBe(
      'trailing punctuation…',
    );
  });

  it('M3.5 lead is the first sentence, shortened only when that sentence is itself too long', () => {
    expect(lead(AC1.replace('AC1: ', ''), MAX_REQUIREMENT_CHARS)).toBe(
      'Only users with the role admin can export user data.',
    );
    expect(lead(AC1_EVIDENCE, MAX_EVIDENCE_CHARS)).toBe(firstSentence(AC1_EVIDENCE));
    const long = `${'word '.repeat(60)}end. Second sentence.`;
    expect(lead(long, MAX_EVIDENCE_CHARS).endsWith('…')).toBe(true);
    expect(lead(long, MAX_EVIDENCE_CHARS).length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    expect([MAX_REQUIREMENT_CHARS, MAX_EVIDENCE_CHARS]).toEqual([60, 160]);
  });

  it('M3.5 the checklist line is the first expected result, cut at a word boundary', () => {
    expect(
      expectedSummary(scenario({ then: ['', '  Request 6 returns HTTP 429 and no CSV data', 'later'] })),
    ).toBe('Request 6 returns HTTP 429 and no CSV data');
    const long = expectedSummary(scenario({ then: [`Response is ${'very '.repeat(30)}long`] }));
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/very…$/);
    expect(expectedSummary(scenario({ then: [] }))).toBe('');
  });
});

describe('top section rendered from round 0 text (M3.5)', () => {
  const report = richReport({
    prdAlignment: {
      status: 'misaligned',
      findings: [
        {
          requirement: AC1,
          source: 'acme/shop#45',
          status: 'contradicts',
          evidence: AC1_EVIDENCE,
          files: ['src/coupon.ts'],
        },
        {
          requirement: AC3,
          source: 'acme/shop#45',
          status: 'missing',
          evidence: AC3_EVIDENCE,
          files: ['src/coupon.ts', 'src/checkout.ts'],
        },
      ],
    },
    scenarios: [
      scenario({
        id: 'TC-01',
        title: 'Manager role is denied export with 403',
        priority: 'P0',
        relatedRequirements: ['AC1'],
        then: ['Response is HTTP 403', 'No CSV data is returned'],
      }),
      scenario({
        id: 'TC-02',
        title: 'Audit entry is written',
        priority: 'P1',
        relatedRequirements: ['AC1', 'AC2'],
      }),
    ],
  });

  it('M3.5 PR comment: label, short requirement, first evidence sentence, file; AC tags on ticket titles', () => {
    const body = renderPrComment(finalReport({ report }));
    expect(body).toContain(
      '- ⛔ **AC1** Only users with the role admin can export user data. — app/admin/export.py defines EXPORT_ROLES = {"admin", "manager"}, and export_users raises Forbidden only when actor.role is not in that set. <code>src/coupon.ts</code>',
    );
    expect(body).toContain(
      '- ❌ **AC3** A user can run at most 5 exports per hour. — Neither export_users in app/admin/export.py nor the route registration in app/admin/routes.py contains any rate limiting, counter or 429 response. <code>src/coupon.ts</code> +1',
    );
    const top = body.slice(0, body.indexOf('<details>'));
    expect(top).not.toContain('…'); // nothing is cut mid-sentence
    expect(top).not.toContain('Every other role gets HTTP 403'); // the AC is not repeated in full
    expect(top).not.toContain('The manager role can therefore still export');
    expect(body).toContain('<b>TC-01 Manager role is denied export with 403</b> [P0 · AC1]</summary>');
    expect(body).toContain('<b>TC-02 Audit entry is written</b> [P1 · AC1, AC2]</summary>');
    // The full requirement and evidence are still in the folded table.
    const table = body.slice(body.indexOf('| --- |'));
    expect(table).toContain('Every other role gets HTTP 403.');
    expect(table).toContain('Roles support and viewer are rejected as required.');
  });

  it('M3.5 Slack shows the same shortened lines and tags', () => {
    const final = finalReport({ report });
    const card = JSON.stringify(buildSummaryCard(final, 'https://github.com/acme/shop/pull/42').blocks);
    expect(card).toContain(
      '*AC1* Only users with the role admin can export user data. — app/admin/export.py defines',
    );
    expect(card).toContain('is not in that set. `src/coupon.ts`');
    expect(card).not.toContain('The manager role can therefore still export');
    const thread = JSON.stringify(buildThreadMessages(final).map((m) => m.blocks));
    expect(thread).toContain('*TC-01 Manager role is denied export with 403* [P0 · AC1]');
    expect(thread).toContain('[P1 · AC1, AC2]');
  });
});

describe('top section in every language (M3.5 snapshots)', () => {
  const TEXT = {
    en: {
      requirement: 'AC3: A user can run at most 5 exports per hour. Further requests get HTTP 429.',
      evidence:
        'Neither export_users nor the route registration contains any rate limiting. A sixth request in the same hour is served like the first.',
      lead: 'Neither export_users nor the route registration contains any rate limiting.',
      title: 'Sixth export within an hour is rejected with 429',
      then: ['Request 6 returns HTTP 429 and no CSV data', 'Requests 1-5 return HTTP 200'],
    },
    ko: {
      requirement:
        'AC3: 사용자는 시간당 최대 5회까지 내보내기를 실행할 수 있다. 그 이후 요청은 HTTP 429를 받는다.',
      evidence:
        'export_users와 라우트 등록 어디에도 호출 횟수 제한이 없습니다. 같은 시간대의 여섯 번째 요청도 첫 번째와 똑같이 처리됩니다.',
      lead: 'export_users와 라우트 등록 어디에도 호출 횟수 제한이 없습니다.',
      title: '1시간 안의 여섯 번째 내보내기는 429로 거부된다',
      then: ['6번째 요청은 HTTP 429를 반환하고 CSV 데이터가 없다', '1~5번째 요청은 HTTP 200을 반환한다'],
    },
    ja: {
      requirement:
        'AC3: ユーザーは1時間に最大5回までエクスポートできる。それ以降のリクエストは HTTP 429 を受け取る。',
      evidence:
        'export_users にもルート登録にも回数制限がありません。同じ時間帯の6回目のリクエストも1回目と同じように処理されます。',
      lead: 'export_users にもルート登録にも回数制限がありません。',
      title: '1時間以内の6回目のエクスポートは 429 で拒否される',
      then: [
        '6回目のリクエストは HTTP 429 を返し、CSV データはない',
        '1~5回目のリクエストは HTTP 200 を返す',
      ],
    },
    'zh-CN': {
      requirement: 'AC3: 每个用户每小时最多导出 5 次。之后的请求返回 HTTP 429。',
      evidence: 'export_users 和路由注册中都没有任何次数限制。同一小时内的第六次请求与第一次的处理方式相同。',
      lead: 'export_users 和路由注册中都没有任何次数限制。',
      title: '一小时内的第六次导出被 429 拒绝',
      then: ['第 6 次请求返回 HTTP 429 且没有 CSV 数据', '第 1~5 次请求返回 HTTP 200'],
    },
  } as const;

  it.each(['en', 'ko', 'ja', 'zh-CN'] as const)(
    'M3.5 %s: short requirement, first evidence sentence, AC tag (snapshot)',
    async (language) => {
      const text = TEXT[language];
      const report = richReport({
        prdAlignment: {
          status: 'partial',
          findings: [
            {
              requirement: text.requirement,
              source: 'acme/shop#45',
              status: 'missing',
              evidence: text.evidence,
              files: ['src/coupon.ts', 'src/checkout.ts'],
            },
          ],
        },
        scenarios: [
          scenario({
            id: 'TC-01',
            title: text.title,
            priority: 'P0',
            relatedRequirements: ['AC3'],
            then: [...text.then],
          }),
          scenario({
            id: 'TC-02',
            title: text.title,
            priority: 'P1',
            relatedRequirements: [text.requirement, 'AC2'],
          }),
        ],
      });
      const body = renderPrComment(finalReport({ language, report }));
      const top = body.slice(0, body.indexOf('<details>'));
      const firstRequirementSentence = firstSentence(text.requirement.replace('AC3: ', ''));
      expect(top).toContain(
        `**AC3** ${firstRequirementSentence} — ${text.lead} <code>src/coupon.ts</code> +1`,
      );
      expect(top).not.toContain('…');
      // The first expected result is what the checklist shows, with its range tilde kept readable.
      expect(top).toContain(`- [ ] **TC-01** ${text.title} → ${text.then[0]}`);
      expect(body).toContain(`<b>TC-01 ${text.title}</b> [P0 · AC3]</summary>`);
      expect(body).toContain(`<b>TC-02 ${text.title}</b> [P1 · AC3, AC2]</summary>`);
      await expect(body).toMatchFileSnapshot(`../../fixtures/delivery/pr-comment.top.${language}.md.snap`);
    },
  );

  it.each([
    ['en', 'All 2 requirement(s) are covered'],
    ['ko', '요구사항 2개 모두 충족'],
    ['ja', '要件 2 件をすべて充足'],
    ['zh-CN', '2 项需求均已覆盖'],
  ] as const)(
    'M3.5 %s: an aligned report says the requirements are covered, not that nothing needs doing',
    (language, line) => {
      const aligned = richReport();
      aligned.prdAlignment.status = 'aligned';
      for (const f of aligned.prdAlignment.findings) f.status = 'covered';
      const body = renderPrComment(finalReport({ language, report: aligned }));
      expect(body).toContain(`✅ **${line}**`);
      // The P0 checklist sits right below it, so the line must not read as "no testing needed".
      expect(body.slice(0, body.indexOf('<details>'))).toContain('TC-01');
      expect(body).not.toMatch(/No action needed|조치 필요 없음|対応不要|无需处理/);
    },
  );
});
