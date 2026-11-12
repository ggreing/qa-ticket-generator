import { describe, expect, it } from 'vitest';
import type { PackedFile } from '../../src/core/contracts';
import { byPriority, fileTokens, pack, sized, splitFile } from '../../src/preprocess/pack';
import { marker } from '../../src/preprocess/redact';
import { changedText, prdKeywords, round3, scoreFile, tokenize } from '../../src/preprocess/score';
import {
  allocatePrdBudget,
  charsForTokens,
  codeBudget,
  estimateTokens,
  PRD_MAX_TOKENS_PER_DOCUMENT,
  prdBudget,
  prdDocumentTokens,
  TRUNCATION_MARKER,
  tokensForChars,
  truncatePrdDocument,
  truncateText,
  usableBudget,
} from '../../src/preprocess/tokens';
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
