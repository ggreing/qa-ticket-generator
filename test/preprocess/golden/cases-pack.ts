/** Golden fixture sources: PRE-07 (score), PRE-08 (tokens / PRD budget), PRE-09 (pack). */
import type { ChangedFile } from '../../../src/core/contracts';
import { file, hunk, input, options, prd } from '../helpers';
import type { GoldenCase } from './types';

/** A modified file with `n` changed lines (`n` additions) whose text mentions `words`. */
function change(path: string, n: number, words = 'value'): ChangedFile {
  const body = [' // context'];
  for (let i = 0; i < n; i++) body.push(`+const v${i} = ${JSON.stringify(`${words} ${i}`)};`);
  return file(path, hunk(1, 1, body));
}

/** A file of roughly `tokens` estimated tokens spread over `hunks` hunks. */
function sizedFile(path: string, tokens: number, hunks = 1): ChangedFile {
  const parts: string[] = [];
  const perHunk = Math.ceil(tokens / hunks);
  for (let h = 0; h < hunks; h++) {
    const lines: string[] = [];
    let chars = 0;
    for (let i = 0; chars < perHunk * 3.2; i++) {
      const line = `+  total += line${h}_${i} * rate; // ${'x'.repeat(40)}`;
      lines.push(line);
      chars += line.length + 1;
    }
    parts.push(hunk(1 + h * 1000, 1 + h * 1000, lines));
  }
  return file(path, parts.join('\n'));
}

const longBody = Array.from(
  { length: 1400 },
  (_, i) => `- Requirement ${i}: coupons must be validated before checkout.`,
).join('\n');

export const packCases: GoldenCase[] = [
  {
    name: 'PRE-07 PRD keywords from titles and acceptance criteria rank matching files first',
    input: input(
      [
        change('src/user/profile.ts', 3),
        change('src/cart/total.ts', 3, 'discount applied'),
        change('src/coupon/expiry.ts', 3),
        change('src/coupon/couponExpiryJob.ts', 3, 'discount'),
      ],
      [
        prd(
          '7',
          'Coupon expiry',
          'Long background text about marketing that is ignored when criteria exist.',
          ['Given an expired coupon, the discount is not applied'],
        ),
      ],
    ),
  },
  {
    name: 'PRE-07 boostPaths, penalizePaths, test and config files adjust the score',
    input: input(
      [
        change('src/domain/pricing.ts', 2),
        change('src/ui/banner.ts', 2),
        change('scripts/seed.ts', 2),
        change('src/domain/pricing.test.ts', 2),
        change('tsconfig.json', 2),
        change('internal/pricing/pricing_test.go', 2),
      ],
      [],
      {
        scoring: {
          ...options().scoring,
          boostPaths: ['src/domain/**'],
          penalizePaths: ['scripts/**'],
        },
      },
    ),
  },
  {
    name: 'PRE-07 equal scores are ordered by path regardless of input order',
    input: input([
      change('src/b.ts', 2),
      change('src/a.ts', 2),
      change('lib/z.ts', 2),
      change('src/c.ts', 2),
    ]),
  },
  {
    name: 'PRE-08 PRD documents share at most 30% of the budget (water-filling)',
    input: input(
      [change('src/coupon/apply.ts', 2)],
      [
        prd('1', 'Small PRD', 'Short body.', ['Coupons apply once']),
        prd('2', 'Large PRD', longBody, ['Coupons expire after 30 days']),
      ],
      { tokenBudget: 20_000, reservedTokens: 2_000 },
    ),
  },
  {
    name: 'PRE-08 a PRD over 20K tokens is cut to 20K even when the budget allows more',
    input: input(
      [change('src/coupon/apply.ts', 2)],
      [prd('3', 'Huge PRD', `${longBody}\n${longBody}`, ['Coupons stack with gift cards'])],
      { tokenBudget: 150_000 },
    ),
  },
  {
    name: 'PRE-09 overflow switches to map_reduce with directory chunks, best chunk first',
    input: input(
      [
        sizedFile('src/orders/create.ts', 700),
        sizedFile('src/orders/cancel.ts', 600),
        sizedFile('src/billing/invoice.ts', 900),
        sizedFile('src/billing/tax.ts', 300),
        sizedFile('lib/util/format.ts', 200),
        sizedFile('docs/guide.md', 400),
      ],
      [],
      { tokenBudget: 4_000, reservedTokens: 1_000 },
    ),
  },
  {
    name: 'PRE-09 a file over the code budget is split by hunks',
    input: input([sizedFile('src/ledger/engine.ts', 5_000, 4), sizedFile('src/ledger/small.ts', 200)], [], {
      tokenBudget: 4_000,
      reservedTokens: 1_000,
    }),
  },
  {
    name: 'PRE-09 a file whose single hunk exceeds the budget is too_large',
    input: input([sizedFile('src/data/countries.ts', 6_000, 1), sizedFile('src/data/index.ts', 100)], [], {
      tokenBudget: 4_000,
      reservedTokens: 1_000,
    }),
  },
  {
    name: 'PRE-09 skipped lists every exclusion reason, sorted by path',
    input: input(
      [
        sizedFile('src/z/huge.ts', 6_000, 1),
        file('yarn.lock', hunk(1, 1, ['-a', '+b'])),
        file('assets/a.png', undefined, { patchMissing: true }),
        file('src/big.ts', undefined, { patchMissing: true, additions: 9000 }),
        file('src/keep.ts', hunk(1, 1, ['-a', '+b'])),
        file('src/gen.ts', hunk(1, 1, ['+// DO NOT EDIT', ' x'])),
      ],
      [],
      { tokenBudget: 4_000, reservedTokens: 1_000 },
    ),
  },
];
