import type { AuthoredCase } from './build';

export const couponExpiryMissing: AuthoredCase = {
  id: 'coupon-expiry-missing',
  split: 'dev',
  pr: {
    number: 101,
    title: 'Apply coupons at checkout',
    author: 'mina',
    headRef: 'feat/checkout-coupons',
    body: `
Implements https://acme.atlassian.net/browse/SHOP-101

Adds CouponService.apply() and wires it into the checkout cart. Redemption is recorded
through the repository so a coupon cannot be reused.
`,
  },
  prd: [
    {
      source: 'jira',
      id: 'SHOP-101',
      url: 'https://acme.atlassian.net/browse/SHOP-101',
      title: 'Coupons at checkout',
      acceptanceCriteria: [
        'AC1: A coupon can be redeemed only once per user.',
        'AC2: A percentage coupon never discounts more than its maxDiscount amount.',
        'AC3: A coupon whose expiresAt is in the past is rejected with the error COUPON_EXPIRED.',
        'AC4: A coupon cannot be combined with an active promotion on the cart.',
      ],
      body: `
## Background
Marketing wants to send percentage coupons by e-mail. A customer types the code on the
checkout page and sees the discounted total before paying.

## Acceptance Criteria
- AC1: A coupon can be redeemed only once per user.
- AC2: A percentage coupon never discounts more than its maxDiscount amount.
- AC3: A coupon whose expiresAt is in the past is rejected with the error COUPON_EXPIRED.
- AC4: A coupon cannot be combined with an active promotion on the cart.

## Out of scope
Fixed-amount coupons and coupons for shipping costs.
`,
    },
  ],
  files: [
    {
      path: 'src/checkout/coupon.ts',
      content: `
export interface Coupon {
  id: string;
  code: string;
  /** Whole percent, 1-100. */
  percent: number;
  /** Largest discount this coupon may give, in minor units. */
  maxDiscount: number;
  expiresAt: Date;
}

export interface Cart {
  id: string;
  subtotal: number;
  total: number;
  discount: number;
  promotionId?: string;
  couponId?: string;
}

export interface CouponRepository {
  findByCode(code: string): Promise<Coupon | null>;
  /**
   * Records the redemption. Returns false when this user already redeemed the coupon;
   * backed by a unique index on (coupon_id, user_id), so it is safe under concurrency.
   */
  redeemOnce(couponId: string, userId: string): Promise<boolean>;
}
`,
    },
    {
      path: 'src/checkout/coupon-service.ts',
      diff: `
-import type { Cart, CouponRepository } from './coupon';
+import type { Cart, Coupon, CouponRepository } from './coupon';

 export class CouponError extends Error {
   constructor(readonly code: string) {
     super(code);
   }
 }

 export class CouponService {
   constructor(private readonly repo: CouponRepository) {}

-  async apply(cart: Cart, code: string): Promise<Cart> {
+  async apply(cart: Cart, code: string, userId: string): Promise<Cart> {
     const coupon = await this.repo.findByCode(code.trim().toUpperCase());
     if (!coupon) throw new CouponError('COUPON_NOT_FOUND');
-    const discount = Math.floor((cart.subtotal * coupon.percent) / 100);
+    if (cart.promotionId) throw new CouponError('COUPON_NOT_COMBINABLE');
+
+    const discount = this.discountFor(cart.subtotal, coupon);
+    const redeemed = await this.repo.redeemOnce(coupon.id, userId);
+    if (!redeemed) throw new CouponError('COUPON_ALREADY_USED');
     return { ...cart, couponId: coupon.id, discount, total: cart.subtotal - discount };
   }
+
+  private discountFor(subtotal: number, coupon: Coupon): number {
+    const raw = Math.floor((subtotal * coupon.percent) / 100);
+    return Math.min(raw, coupon.maxDiscount);
+  }
 }
`,
    },
    { path: 'package-lock.json', patchMissing: { additions: 0, deletions: 0 } },
  ],
  expected: {
    expectedAlignment: 'partial',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Coupon redeemable once per user',
        labels: ['AC1'],
        keywords: ['once per user'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Discount capped at maxDiscount',
        labels: ['AC2'],
        keywords: ['maxDiscount'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: 'Expired coupons are rejected',
        labels: ['AC3'],
        keywords: ['expiresAt', 'COUPON_EXPIRED'],
        accept: ['missing'],
      },
      {
        id: 'AC4',
        requirement: 'Not combinable with a promotion',
        labels: ['AC4'],
        keywords: ['combined', 'promotion'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      { id: 'expired', risk: 'Applying a coupon whose expiresAt is in the past', keywords: [['expir']] },
      {
        id: 'reuse',
        risk: 'The same user applies the same coupon a second time',
        keywords: [['already', 'second time', 'twice', 'again', 'reuse', 're-use', 'once']],
      },
      {
        id: 'cap',
        risk: 'The percentage discount would exceed maxDiscount and is capped',
        keywords: [['maxdiscount', 'max discount', 'cap', 'maximum discount']],
      },
      {
        id: 'promotion',
        risk: 'Applying a coupon to a cart that already has a promotion',
        keywords: [['promotion']],
      },
    ],
    secondOrder: [
      {
        id: 'zero-percent',
        risk: 'A percentage coupon with a 0% rate is applied.',
        why: 'zero-empty-same; judge r0-r1',
      },
      {
        id: 'discount-above-total',
        risk: 'A coupon whose capped discount is larger than the cart total is applied to a small cart.',
        why: 'zero-empty-same; judge r1',
      },
      {
        id: 'expires-at-now',
        risk: 'A coupon is applied in the same second as its expiresAt.',
        why: 'across-the-line',
      },
      {
        id: 'expires-before-payment',
        risk: 'A coupon is valid when applied on the checkout page and expires before the customer pays.',
        why: 'across-the-line',
      },
      {
        id: 'code-used-by-other-account',
        risk: 'A coupon code e-mailed to one customer is entered by a different account.',
        why: 'who-else; judge r0',
      },
      {
        id: 'reuse-after-refund',
        risk: 'An order paid with the coupon is refunded and the same user applies the coupon again.',
        why: 'and-then; judge r1',
      },
      {
        id: 'promotion-after-coupon',
        risk: 'A promotion becomes active on the cart after the coupon was applied.',
        why: 'other-state',
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description:
          'Gift cards, loyalty points and fixed-amount coupons appear in neither the PRD scope nor the code',
        patterns: ['gift card', 'loyalty point'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['payments', 'typescript', 'missing'],
    notes: 'AC3 (expiry check) is not implemented: Coupon.expiresAt exists but is never read.',
  },
};
