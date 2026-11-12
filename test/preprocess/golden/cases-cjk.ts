/**
 * Golden fixture sources: PRE-08 CJK token estimate (Hangul / kana / Han = 1 token per char,
 * everything else ceil(chars / 3.2)). Sizes are computed with an estimator written independently
 * of src/preprocess/tokens.ts, so the fixtures double-check the implementation.
 */
import { dedent, file, hunk, input, prd } from '../helpers';
import type { GoldenCase } from './types';

const CJK = /[ᄀ-ᇿ　-ヿ㄰-㆏㐀-䶿一-鿿가-힯＀-￯]/g;

/** Independent PRE-08 estimate for one text field. */
export function expectedTokens(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 3.2);
}

const TITLE = '쿠폰 만료 정책';
const ACS = ['만료된 쿠폰은 결제에 적용되지 않는다', '만료 7일 전에 알림을 보낸다'];
const SENTENCE = '쿠폰은 발급일로부터 30일 동안 유효하며 만료일 이후에는 사용할 수 없다.';

/** A Korean PRD body whose document estimate (title + body + criteria) is exactly `target`. */
function koreanPrdBody(target: number): string {
  const fixed = expectedTokens(TITLE) + ACS.reduce((s, a) => s + expectedTokens(a), 0);
  const lines: string[] = [];
  while (expectedTokens([...lines, SENTENCE].join('\n')) + fixed <= target) lines.push(SENTENCE);
  let body = lines.join('\n');
  // Top up with Hangul syllables (exactly +1 token each) to hit the target.
  while (expectedTokens(body) + fixed < target) body += '가';
  if (expectedTokens(body) + fixed !== target) throw new Error('cannot hit the PRD size target exactly');
  return body;
}

const mixedFile = file(
  'src/coupons/expiry.ts',
  hunk(
    3,
    3,
    [
      '   // 쿠폰 만료 처리 (クーポンの有効期限 / 优惠券过期)',
      "-  if (now > coupon.expiresAt) return '만료됨';",
      "+  if (now >= coupon.expiresAt) return '만료된 쿠폰입니다';",
      '   return null;',
    ],
    'export function expiryLabel(coupon: Coupon, now: number) {',
  ),
);

export const cjkCases: GoldenCase[] = [
  {
    name: 'PRE-08 CJK characters count as one token each in mixed-language text',
    input: input(
      [mixedFile],
      [
        prd(
          '11',
          '쿠폰 만료 (Coupon expiry)',
          dedent(`
            ## 배경
            만료된 쿠폰이 결제에 적용되는 버그가 있었다。全角テキスト：ＡＢＣ１２３、「引用」。
            中文说明：优惠券在过期后不能使用。
            English text keeps the chars / 3.2 estimate.
          `),
          ['만료된 쿠폰은 적용되지 않는다', 'Expired coupons are rejected'],
        ),
      ],
    ),
  },
  {
    name: 'PRE-08 a Korean PRD exactly at the 30% share is kept whole',
    input: input([mixedFile], [prd('12', TITLE, koreanPrdBody(6_000), ACS)], {
      tokenBudget: 20_000,
      reservedTokens: 2_000,
    }),
  },
  {
    name: 'PRE-08 a Korean PRD one token over the 30% share is truncated',
    input: input([mixedFile], [prd('13', TITLE, koreanPrdBody(6_001), ACS)], {
      tokenBudget: 20_000,
      reservedTokens: 2_000,
    }),
  },
];
