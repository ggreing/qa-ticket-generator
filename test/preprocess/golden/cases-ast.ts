/** Golden fixture sources: PRE-06 (tree-sitter symbol contexts and the ±20 line fallback). */
import { ALL_AST_LANGUAGES, dedent, input, modified } from '../helpers';
import type { GoldenCase } from './types';

/** Indentation of the template literals below (removed again by `dedent`). */
const BASE = '  ';

/** `n` filler statements so symbols are longer than the hunk that touches them. */
function filler(n: number, indent: string, make: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => indent + make(i).replace(/\n/g, `\n${BASE}`)).join(`\n${BASE}`);
}

const tsOld = dedent(`
  import { Money } from './money';

  export class Cart {
    private items: { sku: string; price: number; qty: number }[] = [];

    add(sku: string, price: number, qty = 1): void {
  ${filler(8, '    ', (i) => `if (sku === 'S${i}') console.debug('sku ${i}');`)}
      this.items.push({ sku, price, qty });
  ${filler(8, '    ', (i) => `if (qty > ${i + 10}) console.debug('bulk ${i}');`)}
    }

    total(): Money {
      return Money.of(this.items.reduce((s, i) => s + i.price * i.qty, 0));
    }
  }

  export const applyCoupon = (total: number, code: string): number => {
  ${filler(8, '  ', (i) => `if (code === 'C${i}') return total - ${i};`)}
    if (code === 'SALE') return total * 0.9;
  ${filler(8, '  ', (i) => `if (code === 'D${i}') return total - ${i * 2};`)}
    return total;
  };
`);
const tsNew = tsOld
  .replace(
    'this.items.push({ sku, price, qty });',
    'if (qty <= 0) throw new RangeError("qty");\n    this.items.push({ sku, price, qty });',
  )
  .replace("if (code === 'SALE') return total * 0.9;", "if (code === 'SALE') return total * 0.85;");

const tsxOld = dedent(`
  import { useState } from 'react';

  export function CouponField({ onApply }: { onApply: (code: string) => void }) {
    const [code, setCode] = useState('');
  ${filler(8, '  ', (i) => `const label${i} = 'Field ${i}';`)}
    const submit = () => onApply(code.trim());
  ${filler(8, '  ', (i) => `const hint${i} = 'Hint ${i}';`)}
    return <input value={code} onChange={(e) => setCode(e.target.value)} onBlur={submit} />;
  }
`);
const tsxNew = tsxOld.replace(
  'const submit = () => onApply(code.trim());',
  'const submit = () => onApply(code.trim().toUpperCase());',
);

const jsOld = dedent(`
  const express = require('express');
  const app = express();

  app.post('/coupons/redeem', async (req, res) => {
  ${filler(8, '  ', (i) => `if (req.body.flag${i}) res.set('x-flag-${i}', '1');`)}
    const result = await redeem(req.body.code);
  ${filler(8, '  ', (i) => `if (result.n${i}) res.set('x-n-${i}', '1');`)}
    res.json(result);
  });

  module.exports.redeem = function redeem(code) {
  ${filler(8, '  ', (i) => `if (code === 'R${i}') return { ok: false, reason: ${i} };`)}
    return { ok: true };
  };
`);
const jsNew = jsOld
  .replace(
    'const result = await redeem(req.body.code);',
    'const result = await redeem(String(req.body.code));',
  )
  .replace('return { ok: true };', 'return { ok: true, at: 0 };');

const pyOld = dedent(`
  from dataclasses import dataclass


  @dataclass
  class Coupon:
      code: str
      percent: int

      @property
      def is_valid(self) -> bool:
  ${filler(8, '        ', (i) => `if self.code == "X${i}":\n            return False`)}
          return 0 < self.percent <= 100


  @app.route("/apply")
  def apply_coupon(total, code):
  ${filler(8, '    ', (i) => `if code == "P${i}":\n        return total - ${i}`)}
      return total * 0.9
`);
const pyNew = pyOld
  .replace('return 0 < self.percent <= 100', 'return 0 < self.percent <= 90')
  .replace('return total * 0.9', 'return round(total * 0.9, 2)');

const javaOld = dedent(`
  package com.acme.shop;

  public class CouponService {
      private final CouponRepository repo;

      public CouponService(CouponRepository repo) {
  ${filler(8, '        ', (i) => `if (repo == null) throw new IllegalStateException("r${i}");`)}
          this.repo = repo;
      }

      public int apply(int total, String code) {
  ${filler(8, '        ', (i) => `if ("J${i}".equals(code)) return total - ${i};`)}
          return total * 9 / 10;
      }
  }
`);
const javaNew = javaOld
  .replace('this.repo = repo;', 'this.repo = java.util.Objects.requireNonNull(repo);')
  .replace('return total * 9 / 10;', 'return Math.max(0, total * 9 / 10);');

const goOld = dedent(`
  package coupons

  type Coupon struct {
  ${filler(8, '\t', (i) => `Field${i} string`)}
  \tPercent int
  ${filler(8, '\t', (i) => `Extra${i} int`)}
  }

  func (c *Coupon) Apply(total int) int {
  ${filler(8, '\t', (i) => `if c.Field${i} == "x" {\n\t\treturn total\n\t}`)}
  \treturn total * (100 - c.Percent) / 100
  }
`);
const goNew = goOld
  .replace('\tPercent int', '\tPercent int `json:"percent"`')
  .replace('\treturn total * (100 - c.Percent) / 100', '\treturn total - total*c.Percent/100');

// 330-line function: signature + ±20 lines around the change.
const bigOld = dedent(`
  export function reconcile(ledger: Ledger, day: string): Report {
  ${filler(330, '  ', (i) => `step(ledger, ${i});`)}
    return report(ledger, day);
  }
`);
const bigNew = bigOld.replace('  step(ledger, 200);', '  stepChecked(ledger, 200);');

const rbOld = dedent(`
  class CouponsController < ApplicationController
  ${filler(30, '  ', (i) => `# line ${i}`)}
    def apply
      render json: { total: params[:total].to_i - 1 }
    end
  ${filler(30, '  ', (i) => `# tail ${i}`)}
  end
`);
const rbNew = rbOld.replace('params[:total].to_i - 1', 'params[:total].to_i - 2');

const topOld = dedent(`
  import { a } from './a';
  import { b } from './b';
  ${filler(30, '', (i) => `export const k${i} = ${i};`)}
`);
const topNew = topOld.replace("import { b } from './b';", "import { b, c } from './b';");

export const astCases: GoldenCase[] = [
  {
    name: 'PRE-06 TypeScript changes expand to the enclosing method and arrow function',
    input: input([modified('src/cart/cart.ts', tsOld, tsNew)]),
  },
  {
    name: 'PRE-06 TSX and JavaScript (named and top-level anonymous functions)',
    input: input([
      modified('web/src/CouponField.tsx', tsxOld, tsxNew),
      modified('server/routes.js', jsOld, jsNew),
    ]),
  },
  {
    name: 'PRE-06 Python changes include decorators and the class-qualified name',
    input: input([modified('api/coupons.py', pyOld, pyNew)]),
  },
  {
    name: 'PRE-06 Java changes expand to the constructor and method',
    input: input([modified('src/main/java/com/acme/shop/CouponService.java', javaOld, javaNew)]),
  },
  {
    name: 'PRE-06 Go changes expand to the struct type and the receiver method',
    input: input([modified('internal/coupons/coupon.go', goOld, goNew)]),
  },
  {
    name: 'PRE-06 symbols over 300 lines keep the signature and ±20 lines around the change',
    input: input([modified('src/ledger/reconcile.ts', bigOld, bigNew)]),
  },
  {
    name: 'PRE-06 unsupported or disabled languages fall back to ±20 line windows',
    input: input(
      [
        modified('app/controllers/coupons_controller.rb', rbOld, rbNew),
        modified('api/coupons.py', pyOld, pyNew),
      ],
      [],
      { astLanguages: ALL_AST_LANGUAGES.filter((l) => l !== 'python') },
    ),
  },
  {
    name: 'PRE-06 changes outside any symbol fall back to ±20 line windows',
    input: input([modified('src/constants.ts', topOld, topNew)]),
  },
  {
    name: 'PRE-06 head contents are redacted before they become contexts',
    input: input([
      modified(
        'src/payments/client.ts',
        // The secret sits inside add(), outside the hunk, so it only reaches the output via the context.
        tsOld.replace("if (sku === 'S0') console.debug('sku 0');", "const key = 'sk_live_FAKE00000000';"),
        tsNew.replace("if (sku === 'S0') console.debug('sku 0');", "const key = 'sk_live_FAKE00000000';"),
      ),
    ]),
  },
];
