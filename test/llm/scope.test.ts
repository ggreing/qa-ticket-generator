/**
 * After the first check of a pull request, new code-derived cases may only come from the lines
 * pushed since (SPEC v3 §2.2). These tests cover the pure part: what counts as a change that can
 * create a risk, what the model may be shown, and the check on what it returns.
 */
import { describe, expect, it } from 'vitest';
import type { CaseDraft } from '../../src/core/cases';
import type { CodeChunk } from '../../src/core/contracts';
import {
  changedLines,
  codeNames,
  isCosmeticPatch,
  outOfScope,
  type ResolvedScope,
  resolveScope,
  scopeCodeFiles,
} from '../../src/llm/scope';
import { chunk } from './support';

/** The commit from the sandbox run: one comment line, which produced six new tickets. */
const COMMENT_ONLY = [
  '@@ -1,3 +1,4 @@',
  '+// Coupon rules for checkout (see issue #1).',
  " import { Cart } from './cart';",
  ' ',
  ' export function applyCoupon(cart: Cart, code: string) {',
].join('\n');

const REAL_CHANGE = [
  '@@ -12,6 +12,9 @@ export function applyCoupon(cart: Cart, code: string) {',
  '   const coupon = find(code);',
  '-  if (!coupon) return cart;',
  '+  if (!coupon) throw new CouponError("unknown");',
  '+  // percent coupons are capped',
  '+  const capped = Math.min(coupon.percent * cart.total, coupon.maxDiscount);',
  '   return cart;',
].join('\n');

const draft = (overrides: Partial<CaseDraft> = {}): CaseDraft => ({
  title: 'Percent coupon above the cap',
  acLabels: [],
  technique: 'boundary',
  priority: 'P1',
  preconditions: ['Cart total 100,000'],
  testData: ['coupon = HALF50'],
  steps: ['Apply the coupon'],
  expected: ['Discount equals maxDiscount'],
  whyEasyToMiss: 'applyCoupon in src/coupon.ts caps the discount with Math.min and has no test for it.',
  origin: 'code',
  ...overrides,
});

/** A chunk whose file has a symbol context for the lines 10–40. */
function couponChunk(paths = ['src/coupon.ts']): CodeChunk {
  const c = chunk('c1', paths);
  for (const file of c.files) {
    file.contexts = [
      {
        kind: 'symbol',
        name: 'applyCoupon',
        startLine: 10,
        endLine: 40,
        text: 'export function applyCoupon(cart, code) {\n  const coupon = find(code);\n  return roundDown(cart);\n}',
      },
      {
        kind: 'symbol',
        name: 'removeCoupon',
        startLine: 50,
        endLine: 60,
        text: 'function removeCoupon() {}',
      },
    ];
  }
  return c;
}

describe('isCosmeticPatch — a change that cannot create a risk', () => {
  it('SPEC v3 §2.2 a commit that only adds a comment changes no behavior', () => {
    expect(isCosmeticPatch('src/coupon.ts', COMMENT_ONLY)).toBe(true);
    expect(isCosmeticPatch('app/coupon.py', '@@ -1 +1,2 @@\n+# coupon rules\n import os')).toBe(true);
    expect(isCosmeticPatch('db/init.sql', '@@ -1 +1,2 @@\n+-- seed data\n select 1;')).toBe(true);
    expect(isCosmeticPatch('src/a.ts', '@@ -1,4 +1,6 @@\n+/**\n+ * Applies a coupon.\n+ */\n fn();')).toBe(
      true,
    );
    expect(isCosmeticPatch('src/a.ts', '@@ -1,2 +1,3 @@\n a();\n+\n b();')).toBe(true); // a blank line
    expect(isCosmeticPatch('docs/x.md', '@@ -1 +1 @@\n-<!-- old -->\n+<!-- new -->')).toBe(true);
  });

  it('re-flowed code is formatting: the same characters once whitespace is ignored', () => {
    const reflow =
      '@@ -1,1 +1,4 @@\n-apply(cart, code, { strict: true });\n+apply(\n+  cart, code,\n+  { strict: true },\n+);';
    expect(isCosmeticPatch('src/a.ts', reflow.replace('{ strict: true },\n', '{ strict: true }\n'))).toBe(
      true,
    );
    expect(isCosmeticPatch('src/a.ts', '@@ -1 +1 @@\n-  if (a) {\n+    if (a) {')).toBe(true);
  });

  it('anything it is not sure about is code', () => {
    expect(isCosmeticPatch('src/coupon.ts', REAL_CHANGE)).toBe(false);
    // A trailing comment on a line of code: the line changed, so it is not waved through.
    expect(isCosmeticPatch('src/a.ts', '@@ -1 +1 @@\n-const max = 5;\n+const max = 5; // per hour')).toBe(
      false,
    );
    // A dereference is not a block-comment line.
    expect(isCosmeticPatch('src/a.c', '@@ -1 +1,2 @@\n+*p = 1;\n return;')).toBe(false);
    // Unknown language: "#" may or may not start a comment there.
    expect(isCosmeticPatch('rules.xyz', '@@ -1 +1,2 @@\n+# looks like a comment\n x')).toBe(false);
    // In TypeScript "#" starts a private field, not a comment.
    expect(isCosmeticPatch('src/a.ts', '@@ -1 +1,2 @@\n+#count = 0;\n x')).toBe(false);
    expect(isCosmeticPatch('src/a.ts', '@@ -1,2 +1 @@\n-doThing();\n x')).toBe(false); // a removed call
  });
});

describe('resolveScope — what the prompt may show', () => {
  it('SPEC v3 §2.2 no scope means the whole pull request, and an empty one means nothing', () => {
    expect(resolveScope(null, [couponChunk()])).toBeNull();
    expect(resolveScope(undefined, [couponChunk()])).toBeNull();
    const empty = resolveScope({ sinceSha: 'a1b2c3d', changes: [] }, [couponChunk()]) as ResolvedScope;
    expect(empty).toEqual({ sinceSha: 'a1b2c3d', files: [] });
    expect(scopeCodeFiles(empty)).toEqual([]);
  });

  it('classifies each changed file: code, comments or formatting only, or not shown to the model', () => {
    const summaryOnly = chunk('c2', ['package.json']);
    for (const f of summaryOnly.files) {
      f.hunks = [];
      f.summary = 'added stripe@15';
    }
    const scope = resolveScope(
      {
        sinceSha: 'a1b2c3d',
        changes: [
          { path: 'src/coupon.ts', patch: REAL_CHANGE },
          { path: 'src/cart.ts', patch: COMMENT_ONLY },
          { path: 'package.json', patch: '@@ -1 +1 @@\n-"stripe": "14"\n+"stripe": "15"' },
          { path: '.env', patch: '@@ -0,0 +1 @@\n+DB_PASSWORD=hunter2hunter2' },
        ],
      },
      [couponChunk(['src/coupon.ts', 'src/cart.ts']), summaryOnly],
    ) as ResolvedScope;
    expect(scope.files.map((f) => [f.path, f.kind])).toEqual([
      ['src/coupon.ts', 'code'],
      ['src/cart.ts', 'cosmetic'],
      ['package.json', 'hidden'], // the preprocessor sends a summary of it, not its diff
      ['.env', 'hidden'], // the preprocessor left it out
    ]);
    // A file the model is not shown keeps its content here too.
    expect(scope.files[2]).toMatchObject({ patch: '', related: '' });
    expect(JSON.stringify(scope)).not.toContain('hunter2');
    expect(scopeCodeFiles(scope).map((f) => f.path)).toEqual(['src/coupon.ts']);
    expect(scopeCodeFiles(scope, summaryOnly)).toEqual([]);
  });

  it('PRE-05 a patch is used as core passed it: already masked once, and not masked again', () => {
    // Masking a finalized marker a second time would relabel it (github_token -> token) and count it twice.
    const masked = '@@ -1,2 +1,3 @@\n const a = 1;\n+const token = "[REDACTED:github_token]";\n b();';
    const scope = resolveScope({ sinceSha: 'a1b2c3d', changes: [{ path: 'src/coupon.ts', patch: masked }] }, [
      couponChunk(),
    ]) as ResolvedScope;
    expect(scope.files[0]?.patch).toBe(masked);
    expect(scope.files[0]?.kind).toBe('code');
  });

  it('knows which lines changed, and takes the functions around them as part of the change', () => {
    expect(changedLines(REAL_CHANGE)).toEqual([13, 14, 15]);
    expect(changedLines('@@ -5,3 +5,2 @@\n a\n-b\n c\n@@ -20 +19,2 @@\n d\n+e')).toEqual([6, 20]);
    expect(changedLines('no hunk header\n+x')).toEqual([]);
    const scope = resolveScope({ sinceSha: 's', changes: [{ path: 'src/coupon.ts', patch: REAL_CHANGE }] }, [
      couponChunk(),
    ]) as ResolvedScope;
    // Lines 13–15 are inside applyCoupon (10–40), not inside removeCoupon (50–60).
    expect(scope.files[0]?.related).toContain('roundDown(cart)');
    expect(scope.files[0]?.related).not.toContain('removeCoupon');
    expect(scope.files[0]?.patch).not.toContain('roundDown'); // shown: the patch only
  });
});

describe('outOfScope — the check on what the model returns', () => {
  const scope = resolveScope(
    {
      sinceSha: 'a1b2c3d',
      changes: [
        { path: 'src/coupon.ts', patch: REAL_CHANGE },
        { path: 'src/cart.ts', patch: COMMENT_ONLY },
      ],
    },
    [couponChunk(['src/coupon.ts', 'src/cart.ts', 'src/checkout.ts'])],
  ) as ResolvedScope;

  it('SPEC v3 §2.2 a case about the pushed lines passes', () => {
    expect(outOfScope(draft(), scope)).toBeNull();
    // By file name alone, and in Korean.
    expect(
      outOfScope(
        draft({ whyEasyToMiss: 'coupon.ts의 applyCoupon에서 maxDiscount 상한을 Math.min으로 적용' }),
        scope,
      ),
    ).toBeNull();
    // A name that is only in the function around the change, not in the hunk itself.
    expect(
      outOfScope(draft({ whyEasyToMiss: 'src/coupon.ts calls roundDown after the cap.' }), scope),
    ).toBeNull();
    // No code named at all: the file is enough, because nothing more can be checked.
    expect(
      outOfScope(draft({ whyEasyToMiss: 'The cap in src/coupon.ts has no upper test.' }), scope),
    ).toBeNull();
  });

  it('a case that names no changed file is dropped', () => {
    expect(
      outOfScope(
        draft({ whyEasyToMiss: 'CheckoutService.pay in src/checkout.ts retries without a key.' }),
        scope,
      ),
    ).toBe('no_changed_file_named');
    // A file that changed only in comments is not a changed file for this purpose.
    expect(outOfScope(draft({ whyEasyToMiss: 'Cart.total in src/cart.ts overflows.' }), scope)).toBe(
      'no_changed_file_named',
    );
    expect(outOfScope(draft({ whyEasyToMiss: 'The discount is never capped.' }), scope)).toBe(
      'no_changed_file_named',
    );
  });

  it('a case that names the changed file but code the change did not touch is dropped', () => {
    expect(
      outOfScope(
        draft({ whyEasyToMiss: 'removeCoupon in src/coupon.ts leaves the discount on the cart.' }),
        scope,
      ),
    ).toBe('unchanged_code_named');
    // The file name itself is not taken for a code name.
    expect(
      outOfScope(draft({ whyEasyToMiss: 'src/coupon.ts changed how unknown codes fail.' }), scope),
    ).toBeNull();
  });

  it('when nothing that can change behavior was pushed, no case passes', () => {
    const cosmetic = resolveScope(
      { sinceSha: 's', changes: [{ path: 'src/coupon.ts', patch: COMMENT_ONLY }] },
      [couponChunk()],
    ) as ResolvedScope;
    expect(outOfScope(draft(), cosmetic)).toBe('no_behavior_change');
    expect(outOfScope(draft(), { sinceSha: 's', files: [] })).toBe('no_behavior_change');
  });

  it('takes only what is clearly a code name out of a sentence', () => {
    expect(
      codeNames(
        'WishlistService.add in src/wishlist.ts reads MAX_ITEMS, then calls save() and `flush`.',
      ).sort(),
    ).toEqual(['MAX_ITEMS', 'WishlistService', 'add', 'flush', 'save', 'wishlist'].sort());
    expect(codeNames('The spec does not say whether the limit is included.')).toEqual([]);
    expect(codeNames('expiresAt 비교에서 Invalid Date 처리 없음')).toEqual(['expiresAt']);
  });
});
