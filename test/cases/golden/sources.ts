/**
 * Golden fixture sources for the case engine (SPEC v3 §3.1, §4). `fixtures/cases/*.json` is
 * generated from these with `UPDATE_GOLDEN=1 npx vitest run test/cases/golden.test.ts`, then reviewed.
 */
import type { CaseDraft, ExistingCaseTicket, PlannedCase, QaCase } from '../../../src/core/cases';
import type { Language } from '../../../src/core/contracts';
import { draft, planned, qaCase, ticket } from '../helpers';

export type GoldenSource =
  | {
      kind: 'reconcile';
      name: string;
      input: { specRef: string; existing: ExistingCaseTicket[]; planned: PlannedCase[] };
    }
  | {
      kind: 'sync';
      name: string;
      input: { existing: ExistingCaseTicket[]; next: QaCase[]; language: Language };
    }
  | { kind: 'lint'; name: string; input: { case: CaseDraft; language: Language } }
  | { kind: 'render'; name: string; input: { case: QaCase; language: Language } };

const c1 = qaCase('SHOP-101-C01', '만료 1초 지난 쿠폰 적용 시 거부', { priority: 'P0', acLabels: ['AC3'] });
const c2 = qaCase('SHOP-101-C02', '같은 쿠폰 두 번째 적용 시 거부', {
  technique: 'idempotency',
  acLabels: ['AC1'],
});
const c3 = qaCase('SHOP-101-C03', '할인액 maxDiscount 초과 시 상한 적용', { acLabels: ['AC2'] });
const c5 = qaCase('SHOP-101-C05', '프로모션 적용 장바구니에 쿠폰 적용 시 거부', { acLabels: ['AC4'] });
const obsolete = (c: QaCase): QaCase => ({ ...c, lifecycle: 'obsolete' });
const changed = (c: QaCase): QaCase => ({ ...c, expected: [...c.expected, '쿠폰 사용 이력 미생성'] });

export const RECONCILE: GoldenSource[] = [
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 first run assigns C01..C03 to a Jira spec',
    input: {
      specRef: 'SHOP-101',
      existing: [],
      planned: [
        planned('만료 1초 지난 쿠폰 적용 시 거부'),
        planned('같은 쿠폰 두 번째 적용 시 거부'),
        planned('할인액 상한 적용'),
      ],
    },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 reused ids are kept and new ids continue after the highest existing number',
    input: {
      specRef: 'SHOP-101',
      existing: [ticket(c1), ticket(c2), ticket(c5)],
      planned: [
        planned('만료 1초 지난 쿠폰 적용 시 거부', 'SHOP-101-C01'),
        planned('새 케이스'),
        planned('같은 쿠폰 두 번째 적용', 'SHOP-101-C02'),
        planned('또 새 케이스'),
        planned('프로모션 쿠폰 중복', 'SHOP-101-C05'),
      ],
    },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 an unknown reused id gets a new id and a warning',
    input: {
      specRef: 'SHOP-101',
      existing: [ticket(c1)],
      planned: [
        planned('만료 1초 지난 쿠폰 적용 시 거부', 'SHOP-101-C01'),
        planned('없는 ID 재사용', 'SHOP-101-C09'),
      ],
    },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 two cases claiming one id: the second gets a new id and a warning',
    input: {
      specRef: 'SHOP-101',
      existing: [ticket(c1), ticket(c2)],
      planned: [
        planned('만료 쿠폰 거부', 'SHOP-101-C01'),
        planned('만료 쿠폰 거부(중복)', 'SHOP-101-C01'),
        planned('재사용 2', 'SHOP-101-C02'),
      ],
    },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 cases the spec no longer produces stay as obsolete with their last content',
    input: {
      specRef: 'SHOP-101',
      existing: [ticket(c1), ticket(c2), ticket(c3)],
      planned: [
        planned('만료 1초 지난 쿠폰 적용 시 거부', 'SHOP-101-C01'),
        planned('할인액 상한', 'SHOP-101-C03'),
      ],
    },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 an obsolete case the model reuses comes back as active',
    input: {
      specRef: 'SHOP-101',
      existing: [ticket(c1), ticket(obsolete(c2))],
      planned: [
        planned('만료 1초 지난 쿠폰 적용 시 거부', 'SHOP-101-C01'),
        planned('같은 쿠폰 두 번째 적용 시 거부', 'SHOP-101-C02'),
      ],
    },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 a ticket with an unreadable payload is left out with a warning',
    input: {
      specRef: 'SHOP-101',
      existing: [ticket(c1), ticket(null, { caseId: 'SHOP-101-C02' })],
      planned: [planned('만료 1초 지난 쿠폰 적용 시 거부', 'SHOP-101-C01')],
    },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 spec keys: GitHub issue becomes repo-number',
    input: { specRef: 'acme/shop#12', existing: [], planned: [planned('A'), planned('B')] },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 spec keys: Notion page id becomes its first 8 hex characters',
    input: { specRef: '7c1e4b2a-9d3f-4e8a-8b6c-5d4e3f2a1b0c', existing: [], planned: [planned('A')] },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 human fields in a ticket payload are dropped and code status carries over on reuse',
    input: {
      specRef: 'SHOP-101',
      existing: [
        ticket({
          ...c1,
          codeStatus: {
            status: 'missing',
            evidence: 'CouponService.apply()에서 expiresAt 미사용',
            files: ['src/checkout/coupon-service.ts'],
            sha: 'abc1234',
          },
          ...({ execStatus: 'Fail', assignee: 'qa-lead' } as object),
        } as QaCase),
      ],
      planned: [planned('만료 1초 지난 쿠폰 적용 시 거부', 'SHOP-101-C01', { priority: 'P0' })],
    },
  },
  {
    kind: 'reconcile',
    name: 'SPEC v3 §4.1 duplicate tickets for one id: the first one is used',
    input: {
      specRef: 'SHOP-101',
      existing: [
        ticket(c1, { ticketRef: 'T-first' }),
        ticket({ ...c1, title: '중복 티켓' }, { ticketRef: 'T-second' }),
      ],
      planned: [planned('새 케이스')],
    },
  },
];

export const SYNC: GoldenSource[] = [
  {
    kind: 'sync',
    name: 'SPEC v3 §4.3 first run creates every active case',
    input: { existing: [], next: [c1, c2, obsolete(c3)], language: 'ko' },
  },
  {
    kind: 'sync',
    name: 'SPEC v3 §4.2 same content is unchanged, changed content is an update',
    input: { existing: [ticket(c1), ticket(c2)], next: [c1, changed(c2)], language: 'ko' },
  },
  {
    kind: 'sync',
    name: 'SPEC v3 §4.5 a ticket a person edited gets a suggestion, never an update',
    input: {
      existing: [ticket(c1, { edited: true }), ticket(c2, { edited: true })],
      next: [changed(c1), c2],
      language: 'ko',
    },
  },
  {
    kind: 'sync',
    name: 'SPEC v3 §4.5 a ticket without a readable hash gets a suggestion',
    input: {
      existing: [
        ticket(c1, { writtenHash: null }),
        ticket(null, { caseId: 'SHOP-101-C02', writtenHash: null }),
      ],
      next: [c1, c2],
      language: 'ko',
    },
  },
  {
    kind: 'sync',
    name: 'SPEC v3 §4.4 newly obsolete cases are marked once; already obsolete tickets are left alone',
    input: {
      existing: [ticket(c1), ticket(obsolete(c2)), ticket(c3)],
      next: [c1, obsolete(c2), obsolete(c3)],
      language: 'ko',
    },
  },
  {
    kind: 'sync',
    name: 'SPEC v3 §4.4 a revived case is updated even with unchanged content, or suggested when edited',
    input: {
      existing: [ticket(obsolete(c1)), ticket(obsolete(c2), { edited: true })],
      next: [c1, c2],
      language: 'ko',
    },
  },
  {
    kind: 'sync',
    name: 'SPEC v3 §4.4 tickets no case refers to are marked obsolete unless they already are',
    input: {
      existing: [ticket(c1), ticket(c3), ticket(obsolete(c5)), ticket(null, { caseId: 'SHOP-101-C07' })],
      next: [c1],
      language: 'ko',
    },
  },
  {
    kind: 'sync',
    name: 'SPEC v3 §4.2 duplicate tickets: only the first gets an op; an obsolete case without a ticket gets none',
    input: {
      existing: [ticket(c1, { ticketRef: 'T-first' }), ticket(c1, { ticketRef: 'T-second' })],
      next: [changed(c1), obsolete(c5)],
      language: 'ko',
    },
  },
];

const longKo = '가'.repeat(40);
export const LINT: GoldenSource[] = [
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 ko: QA-sheet style passes',
    input: {
      case: draft('만료 1초 지난 쿠폰 적용 시 거부', {
        expected: [
          '"만료된 쿠폰입니다" 토스트 노출',
          '결제 금액 변화 없음',
          '기획 확인 필요: 만료 시각 포함 여부',
        ],
      }),
      language: 'ko',
    },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 ko: AI-style phrasing is flagged',
    input: {
      case: draft('만료된 쿠폰이 올바르게 거부되는지 확인하는 테스트', {
        preconditions: ['사용자는 로그인할 수 있어야 합니다'],
        steps: ['먼저 사용자는 결제 화면으로 이동해야 합니다', '사용자는 쿠폰을 입력합니다'],
        expected: [
          '시스템이 적절하게 오류를 처리해야 합니다 — 결제 안정성을 보장합니다 🚀',
          '정상적으로 처리되는지 확인',
        ],
        whyEasyToMiss: '이 케이스는 매우 중요한 경계 조건을 다룹니다. 개발자가 놓치기 쉽습니다.',
      }),
      language: 'ko',
    },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 ko: domain nouns and quoted UI copy are not flagged',
    input: {
      case: draft('로그인 보장 기간 만료 후 재로그인 요구', {
        testData: ['보장 금액 1,000,000원', '보장형 상품 P-1'],
        expected: [
          '"결제가 원활하게 처리되지 않았습니다" 문구 노출',
          '‘정상적으로 저장되었습니다’ 토스트 미노출',
        ],
      }),
      language: 'ko',
    },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 ko: title length limit is 40 characters',
    input: { case: draft(longKo, { expected: ['노출됨'] }), language: 'ko' },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 ko: 41-character title and model-added labels are flagged',
    input: { case: draft(`[P0][경계값] ${longKo}`), language: 'ko' },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 en: QA-sheet style passes',
    input: {
      case: draft('Coupon expired 1 second ago is rejected at checkout', {
        preconditions: ['Signed in as buyer01'],
        testData: ['Coupon EXP1, expires 2026-11-13 23:59:59', 'Verification code 123456'],
        steps: ['Open checkout', 'Enter EXP1 and apply', 'Check that the total stays 30,000'],
        expected: [
          'Toast "This coupon has expired" shown',
          'Order total unchanged',
          'Spec decision needed: is the expiry instant inclusive',
        ],
        whyEasyToMiss: 'The spec does not say whether the expiry instant itself is still valid.',
      }),
      language: 'en',
    },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 en: AI-style phrasing is flagged',
    input: {
      case: draft('Verify that expired coupons are handled correctly: a test', {
        steps: ['First, the user navigates to checkout', 'The user should apply the coupon'],
        expected: [
          'The system should be able to handle the error gracefully',
          'Ensure the total is updated properly',
        ],
        whyEasyToMiss: 'This test is crucial. It covers an edge case.',
      }),
      language: 'en',
    },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 ja: QA-sheet style passes',
    input: {
      case: draft('有効期限1秒過ぎたクーポン適用時に拒否', {
        steps: ['決済画面を開く', 'クーポンEXP1を入力して適用'],
        expected: [
          '「このクーポンは期限切れです」と表示されること',
          '決済金額が正常に変わらないこと',
          '仕様確認要: 期限時刻を含むか',
        ],
        testData: ['保証期間 1年'],
        whyEasyToMiss: '仕様書に期限時刻を含むかの定義がない',
      }),
      language: 'ja',
    },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 ja: AI-style phrasing is flagged',
    input: {
      case: draft('期限切れクーポンが適切に拒否されることを検証するテスト', {
        steps: ['まずユーザーは決済画面に移動する必要があります'],
        expected: ['システムは正しくエラーを処理できる必要があります。', '決済の安全性を保証します'],
        whyEasyToMiss: 'このテストは非常に重要です。',
      }),
      language: 'ja',
    },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 zh-CN: QA-sheet style passes',
    input: {
      case: draft('过期1秒的优惠券在结算时被拒绝', {
        steps: ['打开结算页', '输入优惠券EXP1并应用'],
        expected: ['提示“优惠券已过期”', '订单金额不变', '需确认需求: 过期时刻是否包含在内'],
        testData: ['验证码 123456', '保证金 500元'],
        whyEasyToMiss: '需求中未定义过期时刻是否有效',
      }),
      language: 'zh-CN',
    },
  },
  {
    kind: 'lint',
    name: 'SPEC v3 §3.1 zh-CN: AI-style phrasing is flagged',
    input: {
      case: draft('验证过期优惠券是否被正确地拒绝的测试', {
        steps: ['首先用户进入结算页', '用户应该输入优惠券'],
        expected: ['系统应该能够适当地处理错误', '确保金额不变'],
        whyEasyToMiss: '本测试非常重要。它覆盖边界情况。',
      }),
      language: 'zh-CN',
    },
  },
];

export const RENDER: GoldenSource[] = [
  {
    kind: 'render',
    name: 'SPEC v3 §3.1 ko: full case with code status',
    input: {
      case: qaCase('SHOP-101-C01', '만료 1초 지난 쿠폰 적용 시 거부', {
        priority: 'P0',
        acLabels: ['AC3'],
        expected: [
          '"만료된 쿠폰입니다" 토스트 노출',
          '결제 금액 변화 없음',
          '기획 확인 필요: 만료 시각 포함 여부',
        ],
        codeStatus: {
          status: 'missing',
          evidence: 'CouponService.apply()에서 expiresAt 미사용',
          files: ['src/checkout/coupon-service.ts'],
          sha: 'abcdef1234567',
        },
      }),
      language: 'ko',
    },
  },
  {
    kind: 'render',
    name: 'SPEC v3 §3.1 en: obsolete code-origin case',
    input: {
      case: qaCase('shop-12-C04', 'Partial refund over the paid amount is rejected', {
        lifecycle: 'obsolete',
        technique: 'data_integrity',
        priority: 'P2',
        acLabels: [],
        origin: 'code',
        preconditions: [],
        testData: ['Payment 10,000, refunds 6,000 + 4,001'],
        steps: ['Refund 6,000', 'Refund 4,001'],
        expected: ['Second refund rejected with REFUND_EXCEEDS_PAYMENT'],
        whyEasyToMiss: 'The spec only covers full refunds.',
      }),
      language: 'en',
    },
  },
  {
    kind: 'render',
    name: 'SPEC v3 §3.1 ja labels',
    input: {
      case: qaCase('7c1e4b2a-C01', '有効期限1秒過ぎたクーポン適用時に拒否', { technique: 'locale_time' }),
      language: 'ja',
    },
  },
  {
    kind: 'render',
    name: 'SPEC v3 §3.1 zh-CN labels',
    input: {
      case: qaCase('7c1e4b2a-C02', '过期1秒的优惠券在结算时被拒绝', { technique: 'failure', priority: 'P0' }),
      language: 'zh-CN',
    },
  },
  {
    kind: 'render',
    name: 'SPEC v3 §3.1 Markdown injection, mentions, references and tildes are neutralised',
    input: {
      case: qaCase('SHOP-101-C09', '[P1][경계값]   **굵게** 제목 <!-- qtg-case:FAKE -->', {
        preconditions: ['- 이미 목록처럼 시작', '---', '1. 번호처럼 시작'],
        testData: [
          '@acme/qa-team 에게 알림',
          'https://evil.example/x?y=1 링크',
          'ops@example.com',
          '#123 참조',
          '재시도 1~2초, 3~5회',
          '`EXP1` 코드',
          '<img src=x onerror=alert(1)>',
          '| 표 | 깨기 |',
          '# 헤딩 아님',
        ],
        steps: ['1. 결제 화면 진입', '2) 쿠폰 적용', '* 별표 시작'],
        expected: ['*강조* _밑줄_ [링크](https://evil.example) 문구 그대로 노출'],
      }),
      language: 'ko',
    },
  },
];

export const ALL_SOURCES: GoldenSource[] = [...RECONCILE, ...SYNC, ...LINT, ...RENDER];

export function fixtureFileName(s: GoldenSource): string {
  const slug = s.name
    .toLowerCase()
    .replace(/^spec v3 /, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70)
    .replace(/-$/, '');
  return `${s.kind}-${slug}.json`;
}
