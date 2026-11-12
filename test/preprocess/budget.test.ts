import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PackedFile, PreprocessInput, PreprocessOutput } from '../../src/core/contracts';
import { byPriority, fileTokens, pack, sized, splitFile } from '../../src/preprocess/pack';
import { marker } from '../../src/preprocess/redact';
import { changedText, prdKeywords, round3, scoreFile, tokenize } from '../../src/preprocess/score';
import {
  allocatePrdBudget,
  charsForTokens,
  codeBudget,
  countCjk,
  estimateTokens,
  fitPrefix,
  isCjk,
  PRD_MAX_TOKENS_PER_DOCUMENT,
  prdBudget,
  prdDocumentTokens,
  TRUNCATION_MARKER,
  tokensForChars,
  truncatePrdDocument,
  truncateText,
  usableBudget,
} from '../../src/preprocess/tokens';
import { expectedTokens } from './golden/cases-cjk';
import { options, prd, rng } from './helpers';

describe('PRE-08 token estimation and budget', () => {
  it('PRE-08 estimates ceil(chars / 3.2) with integer math', () => {
    for (const n of [0, 1, 3, 16, 17, 31, 32, 33, 100, 12345]) {
      expect(tokensForChars(n)).toBe(Math.ceil(n / 3.2));
    }
    expect(estimateTokens('a'.repeat(32))).toBe(10);
  });

  it('PRE-08 charsForTokens is the inverse bound', () => {
    for (const t of [0, 1, 5, 99, 20_000]) {
      const c = charsForTokens(t);
      expect(tokensForChars(c)).toBeLessThanOrEqual(t);
      expect(tokensForChars(c + 1)).toBeGreaterThan(t);
    }
    expect(charsForTokens(-5)).toBe(0);
  });

  it('PRE-08 keeps a 10% safety margin, PRD ≤ 30%, code gets the rest', () => {
    expect(usableBudget(150_000)).toBe(135_000);
    expect(prdBudget(150_000)).toBe(45_000);
    expect(codeBudget(150_000, 6_000, 10_000)).toBe(119_000);
    expect(codeBudget(20_000, 50_000, 0)).toBe(0);
  });

  it('PRE-08 water-filling serves small documents fully and caps each at 20K', () => {
    expect(allocatePrdBudget([100, 50_000, 900], 6_000)).toEqual([100, 5_000, 900]);
    expect(allocatePrdBudget([30_000], 45_000)).toEqual([PRD_MAX_TOKENS_PER_DOCUMENT]);
    expect(allocatePrdBudget([5_000, 5_000], 6_000)).toEqual([3_000, 3_000]);
    expect(allocatePrdBudget([], 6_000)).toEqual([]);
  });

  it('PRE-08 truncation keeps title and criteria first, then the body', () => {
    const doc = prd('1', 'Title', 'x'.repeat(10_000), ['AC one', 'AC two']);
    const out = truncatePrdDocument(doc, 500);
    expect(prdDocumentTokens(out)).toBeLessThanOrEqual(500);
    expect(out.acceptanceCriteria).toEqual(['AC one', 'AC two']);
    expect(out.bodyMarkdown.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(truncatePrdDocument(doc, 1_000_000)).toBe(doc);
  });

  it('PRE-08 drops trailing criteria when even they do not fit', () => {
    const doc = prd('1', 'T', 'body', ['a'.repeat(320), 'b'.repeat(320), 'c'.repeat(320)]);
    const out = truncatePrdDocument(doc, 230);
    expect(out.acceptanceCriteria).toEqual(['a'.repeat(320), 'b'.repeat(320)]);
    expect(out.bodyMarkdown).toBe(`body${TRUNCATION_MARKER}`);
    expect(prdDocumentTokens(out)).toBeLessThanOrEqual(230);
    const tiny = truncatePrdDocument(prd('2', 'A long title here', 'body', []), 15);
    expect(prdDocumentTokens(tiny)).toBeLessThanOrEqual(15);
  });

  it('PRE-08 truncateText prefers a nearby line break and never cuts a marker', () => {
    expect(truncateText('aaaa\nbbbb', 8)).toBe('aaaa\nbbb');
    expect(truncateText('aaaaaaaa\nbbbb', 10)).toBe('aaaaaaaa');
    expect(truncateText('short', 10)).toBe('short');
    const text = `${'a'.repeat(10)}${marker('jwt')}`;
    expect(truncateText(text, 15)).toBe('a'.repeat(10));
  });
});

describe('PRE-08 CJK estimate', () => {
  it.each([
    ['쿠폰 만료', 4 + 1],
    ['クーポン', 4],
    ['优惠券过期', 5],
    ['ＡＢＣ１２３', 6],
    ['「」、。', 4],
    ['ㄱㄴㄷ', 3],
    ['ᄀᄁ', 2],
    ['coupon 쿠폰', 2 + Math.ceil(7 / 3.2)],
    ['😀', 1],
    ['', 0],
  ])('PRE-08 estimates %j as %i tokens', (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
    expect(expectedTokens(text)).toBe(tokens);
  });

  it('PRE-08 CJK range boundaries', () => {
    for (const c of [
      0x1100, 0x11ff, 0x3000, 0x30ff, 0x3130, 0x318f, 0x3400, 0x4dbf, 0x4e00, 0x9fff, 0xac00, 0xd7af, 0xff00,
      0xffef,
    ]) {
      expect(isCjk(c), c.toString(16)).toBe(true);
    }
    for (const c of [
      0x10ff, 0x1200, 0x2fff, 0x3100, 0x3190, 0x33ff, 0x4dc0, 0xa000, 0xabff, 0xd7b0, 0xfeff, 0xfff0, 0x41,
    ]) {
      expect(isCjk(c), c.toString(16)).toBe(false);
    }
    expect(countCjk('abc')).toBe(0);
    expect(countCjk('a가b나')).toBe(2);
  });

  it('PRE-08 fitPrefix returns the longest prefix within the budget for mixed text', () => {
    const text = 'abc가나다 def라마';
    for (let t = 0; t <= estimateTokens(text) + 1; t++) {
      const n = fitPrefix(text, t);
      expect(estimateTokens(text.slice(0, n))).toBeLessThanOrEqual(t);
      if (n < text.length) expect(estimateTokens(text.slice(0, n + 1))).toBeGreaterThan(t);
    }
    expect(fitPrefix('abcdef', 1)).toBe(3);
    expect(fitPrefix('abc', 100)).toBe(3);
  });

  it('PRE-08 Korean PRD truncation stays within the allowance', () => {
    const doc = prd('1', '쿠폰', '쿠폰은 만료된다.\n'.repeat(500), ['만료 쿠폰 거절']);
    const out = truncatePrdDocument(doc, 300);
    expect(prdDocumentTokens(out)).toBeLessThanOrEqual(300);
    expect(prdDocumentTokens(out)).toBeGreaterThan(280);
  });
});

describe('PRE-08 golden fixtures agree with an independent estimator', () => {
  const dir = fileURLToPath(new URL('../../fixtures/preprocess/', import.meta.url));
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map(
      (f) =>
        JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
          name: string;
          input: PreprocessInput;
          expected: PreprocessOutput;
        },
    );

  it('PRE-08 file, chunk, PRD and total token counts', () => {
    for (const { name, input: inp, expected } of fixtures) {
      for (const chunk of expected.chunks) {
        for (const f of chunk.files) {
          let t =
            16 +
            expectedTokens(f.path) +
            expectedTokens(f.previousPath ?? '') +
            expectedTokens(f.summary ?? '');
          for (const h of f.hunks) t += expectedTokens(h.header) + expectedTokens(h.text);
          for (const c of f.contexts) t += 8 + expectedTokens(c.text) + expectedTokens(c.name ?? '');
          expect(f.estimatedTokens, `${name}: ${f.path}`).toBe(t);
        }
        expect(chunk.estimatedTokens, name).toBe(chunk.files.reduce((s, f) => s + f.estimatedTokens, 0));
      }
      const prdTokens = expected.prdDocuments.reduce(
        (s, d) =>
          s +
          expectedTokens(d.title) +
          expectedTokens(d.bodyMarkdown) +
          d.acceptanceCriteria.reduce((a, c) => a + expectedTokens(c), 0),
        0,
      );
      expect(prdTokens, name).toBeLessThanOrEqual(Math.floor(inp.options.tokenBudget * 0.3));
      const perCall = inp.options.reservedTokens + prdTokens;
      expect(expected.estimatedTokens, name).toBe(
        expected.chunks.reduce((s, c) => s + perCall + c.estimatedTokens, 0),
      );
    }
  });

  it('PRE-08 the 30% boundary fixtures: exactly at the share is whole, one over is truncated', () => {
    const at = fixtures.find((f) => f.name.startsWith('PRE-08 a Korean PRD exactly'));
    const over = fixtures.find((f) => f.name.startsWith('PRE-08 a Korean PRD one token over'));
    const docTokens = (d: PreprocessOutput['prdDocuments'][number]) =>
      expectedTokens(d.title) +
      expectedTokens(d.bodyMarkdown) +
      d.acceptanceCriteria.reduce((a, c) => a + expectedTokens(c), 0);
    expect(docTokens(at?.input.prdDocuments[0] as never)).toBe(6_000);
    expect(at?.expected.prdDocuments[0]).toStrictEqual(at?.input.prdDocuments[0]);
    expect(docTokens(over?.input.prdDocuments[0] as never)).toBe(6_001);
    expect(docTokens(over?.expected.prdDocuments[0] as never)).toBeLessThanOrEqual(6_000);
    expect(over?.expected.prdDocuments[0]?.bodyMarkdown.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe('PRE-07 scoring', () => {
  const w = options().scoring;

  it('PRE-07 tokenizes camelCase, snake_case and paths; drops stopwords, short tokens and plurals', () => {
    expect([...tokenize('applyCouponCode to XMLParser coupons_list the id')].sort()).toEqual(
      ['apply', 'code', 'coupon', 'parser', 'xml'].sort(),
    );
    expect([...tokenize('쿠폰 만료 처리 a 1234')]).toEqual(['쿠폰', '만료', '처리']);
  });

  it('PRE-07 keywords come from titles and criteria, or the body prefix when there are none', () => {
    expect(
      [...prdKeywords([prd('1', 'Refund flow', 'ignored body words', ['Partial refunds allowed'])])].sort(),
    ).toEqual(['flow', 'partial', 'refund', 'allowed'].sort());
    expect(prdKeywords([prd('2', 'Refund', 'Ledger reconciliation', [])]).has('ledger')).toBe(true);
  });

  it('PRE-07 score = w1·kw + w2·ln(1+lines) + w3·boost − w4·penalty, rounded to 3 decimals', () => {
    const kw = new Set(['coupon', 'expiry', 'discount']);
    const s = scoreFile(
      { path: 'src/coupon/expiry.ts', changedLines: 9, changedText: 'const discount = 1' },
      kw,
      { ...w, boostPaths: ['src/**'] },
    );
    expect(s.keyword).toBe(2.5);
    expect(s.boost).toBe(1);
    expect(s.score).toBe(round3(3 * 2.5 + Math.log(10) + 2));
  });

  it('PRE-07 caps the keyword term and counts previousPath tokens as path hits', () => {
    const kw = new Set(['a1x', 'b2x', 'c3x', 'd4x', 'e5x', 'f6x', 'g7x']);
    const s = scoreFile({ path: 'a1x/b2x/c3x/d4x/e5x/f6x.ts', changedLines: 0, changedText: 'g7x' }, kw, w);
    expect(s.keyword).toBe(5);
    const r = scoreFile(
      { path: 'src/new.ts', previousPath: 'src/coupon.ts', changedLines: 0, changedText: '' },
      new Set(['coupon']),
      w,
    );
    expect(r.keyword).toBe(1);
  });

  it('PRE-07 penalizes tests, config, manifests and penalizePaths once', () => {
    for (const path of ['src/a.test.ts', 'tsconfig.json', 'go.mod', 'scripts/x.ts']) {
      const s = scoreFile({ path, changedLines: 0, changedText: '' }, new Set(), {
        ...w,
        penalizePaths: ['scripts/**'],
      });
      expect(s.penalty).toBe(1);
      expect(s.score).toBe(-2);
    }
  });

  it('PRE-07 changedText takes only +/- lines and section headers', () => {
    expect(changedText([{ header: '@@ -1 +1 @@ fn', text: ' ctx\n-old\n+new' }])).toBe(
      '@@ -1 +1 @@ fn\nold\nnew',
    );
  });
});

function pf(path: string, score: number, hunkTokens: number[], extra: Partial<PackedFile> = {}): PackedFile {
  return sized({
    path,
    status: 'modified',
    score,
    hunks: hunkTokens.map((t, i) => ({
      header: `@@ -${i * 100 + 1},1 +${i * 100 + 1},1 @@`,
      oldStart: i * 100 + 1,
      oldLines: 1,
      newStart: i * 100 + 1,
      newLines: 1,
      text: '+'.padEnd(Math.max(1, Math.floor(t * 3.2)), 'x'),
    })),
    contexts: [],
    ...extra,
  });
}

describe('PRE-09 packing', () => {
  it('PRE-09 single mode when everything fits; empty input has no chunks', () => {
    expect(pack([], 1000)).toEqual({ mode: 'single', chunks: [], tooLarge: [] });
    const r = pack([pf('b.ts', 1, [10]), pf('a.ts', 2, [10])], 1000);
    expect(r.mode).toBe('single');
    expect(r.chunks[0]?.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('PRE-09 a file over budget first loses its contexts', () => {
    const f = pf('a.ts', 1, [50], {
      contexts: [{ kind: 'lines', startLine: 1, endLine: 40, text: 'x'.repeat(800) }],
    });
    const parts = splitFile(f, 120);
    expect(parts).toHaveLength(1);
    expect(parts?.[0]?.contexts).toEqual([]);
  });

  it('PRE-09 single-hunk files that do not fit are not splittable', () => {
    expect(splitFile(pf('a.ts', 1, [500]), 100)).toBeNull();
  });

  it('PRE-09 one chunk left after a too_large file is still single mode', () => {
    const r = pack([pf('big.ts', 9, [5000]), pf('small.ts', 1, [10])], 1000);
    expect(r).toMatchObject({ mode: 'single', tooLarge: ['big.ts'] });
    expect(r.chunks).toHaveLength(1);
  });

  it('PRE-09 invariants on random inputs: chunks ≤ budget, chunk[0] holds the top file, deterministic', () => {
    const rand = rng(42);
    for (let round = 0; round < 25; round++) {
      const files: PackedFile[] = [];
      const n = 5 + Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) {
        const dir = ['src/a', 'src/a/b', 'src/c', 'lib', ''][Math.floor(rand() * 5)];
        const hunks = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => 20 + Math.floor(rand() * 400));
        files.push(pf(`${dir ? `${dir}/` : ''}f${i}.ts`, Math.round(rand() * 1000) / 100, hunks));
      }
      const budget = 600 + Math.floor(rand() * 1500);
      const r = pack(files, budget);
      const again = pack([...files].reverse(), budget);
      expect(again).toEqual(r);
      for (const c of r.chunks) {
        expect(c.estimatedTokens).toBeLessThanOrEqual(budget);
        expect(c.estimatedTokens).toBe(c.files.reduce((s, f) => s + f.estimatedTokens, 0));
        expect([...c.files].sort(byPriority)).toEqual(c.files);
      }
      const packedPaths = new Set(r.chunks.flatMap((c) => c.files.map((f) => f.path)));
      for (const f of files) expect(packedPaths.has(f.path) || r.tooLarge.includes(f.path)).toBe(true);
      const top = [...files].filter((f) => !r.tooLarge.includes(f.path)).sort(byPriority)[0];
      if (top) expect(r.chunks[0]?.files.some((f) => f.path === top.path)).toBe(true);
      const maxScores = r.chunks.map((c) => Math.max(...c.files.map((f) => f.score)));
      expect([...maxScores].sort((a, b) => b - a)).toEqual(maxScores);
    }
  });

  it('PRE-09 fileTokens counts path, summary, hunks and contexts', () => {
    const base = { path: 'a.ts', status: 'modified' as const, score: 0, hunks: [], contexts: [] };
    const t0 = fileTokens(base);
    expect(fileTokens({ ...base, previousPath: 'b.ts', summary: 'x'.repeat(32) })).toBe(t0 + 2 + 10);
    expect(
      fileTokens({
        ...base,
        contexts: [{ kind: 'symbol', name: 'f', startLine: 1, endLine: 1, text: 'x'.repeat(32) }],
      }),
    ).toBeGreaterThan(t0 + 10);
  });
});
