/**
 * Token estimation and budget split (PRE-08).
 *
 * - Estimate: CJK characters (see {@link isCjk}) count 1 token each; all other characters are
 *   `ceil(chars / 3.2)` where chars = UTF-16 code units. Integer math (`ceil(5·chars / 16)`) so
 *   every implementation gets bit-identical results:
 *   `tokens = cjk + floor((5·(length − cjk) + 15) / 16)`.
 * - Safety margin: 10% of `tokenBudget` is never allocated.
 * - Budget: reservedTokens (system prompt) + PRD (≤ 30% of the budget, ≤ 20K per document)
 *   + code (the rest). Unused PRD share flows to code.
 */
import type { PrdDocument } from '../core/contracts';
import { safeCut } from './redact';

export const SAFETY_MARGIN = 0.1;
export const PRD_BUDGET_SHARE = 0.3;
export const PRD_MAX_TOKENS_PER_DOCUMENT = 20_000;
export const TRUNCATION_MARKER = '\n\n[truncated: PRD exceeded its token budget]';

/** `ceil(chars / 3.2)` for a count of non-CJK characters. */
export function tokensForChars(chars: number): number {
  return Math.floor((chars * 5 + 15) / 16);
}

/**
 * CJK code points that the estimate counts as one token each (all in the BMP, so one UTF-16 unit):
 * Hangul Jamo, CJK Symbols & Punctuation, Hiragana, Katakana, Hangul Compatibility Jamo,
 * CJK Unified Ideographs Extension A, CJK Unified Ideographs, Hangul Syllables and
 * Halfwidth & Fullwidth Forms.
 */
export function isCjk(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

const CJK_ANY =
  /[\u1100-\u11ff\u3000-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/** Number of CJK characters in `text` (fast path for text without any). */
export function countCjk(text: string): number {
  if (!CJK_ANY.test(text)) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (isCjk(text.charCodeAt(i))) n++;
  return n;
}

/** PRE-08 token estimate: CJK characters 1 token each, everything else `ceil(chars / 3.2)`. */
export function estimateTokens(text: string): number {
  const cjk = countCjk(text);
  return cjk + tokensForChars(text.length - cjk);
}

/** Largest non-CJK character count whose estimate is ≤ `tokens`. */
export function charsForTokens(tokens: number): number {
  return tokens <= 0 ? 0 : Math.floor((tokens * 16) / 5);
}

/** Length of the longest prefix of `text` whose estimate is ≤ `tokens`. */
export function fitPrefix(text: string, tokens: number): number {
  if (tokens <= 0) return 0;
  if (!CJK_ANY.test(text)) return Math.min(text.length, charsForTokens(tokens));
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjk(text.charCodeAt(i))) cjk++;
    if (cjk + tokensForChars(i + 1 - cjk) > tokens) return i;
  }
  return text.length;
}

/** Usable budget after the safety margin. */
export function usableBudget(tokenBudget: number): number {
  return Math.floor(tokenBudget * (1 - SAFETY_MARGIN));
}

export function prdBudget(tokenBudget: number): number {
  return Math.floor(tokenBudget * PRD_BUDGET_SHARE);
}

/** Code budget per LLM call: usable − reserved − PRD actually used (never negative). */
export function codeBudget(tokenBudget: number, reservedTokens: number, prdTokens: number): number {
  return Math.max(0, usableBudget(tokenBudget) - reservedTokens - prdTokens);
}

export function prdDocumentTokens(
  doc: Pick<PrdDocument, 'title' | 'bodyMarkdown' | 'acceptanceCriteria'>,
): number {
  let t = estimateTokens(doc.title) + estimateTokens(doc.bodyMarkdown);
  for (const ac of doc.acceptanceCriteria) t += estimateTokens(ac);
  return t;
}

/**
 * Water-filling allocation: documents are served smallest first, each gets at most
 * min(its size, 20K, an equal share of what is left). Returns allowances in input order.
 */
export function allocatePrdBudget(sizes: readonly number[], total: number): number[] {
  const order = sizes
    .map((size, index) => ({ size, index }))
    .sort((a, b) => a.size - b.size || a.index - b.index);
  const out = new Array<number>(sizes.length).fill(0);
  let remaining = total;
  order.forEach((d, i) => {
    const share = Math.floor(remaining / (order.length - i));
    const give = Math.max(0, Math.min(d.size, PRD_MAX_TOKENS_PER_DOCUMENT, share));
    out[d.index] = give;
    remaining -= give;
  });
  return out;
}

/** Cuts `text` to at most `maxChars`, preferring a line break in the last 20% of the window. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = safeCut(text, maxChars);
  const nl = text.lastIndexOf('\n', cut - 1);
  if (nl >= 0 && nl >= Math.floor(cut * 0.8)) cut = nl;
  return text.slice(0, cut);
}

/**
 * Truncates one (already redacted) document to `allowance` tokens. Title and acceptance criteria
 * are kept first; the body is cut and suffixed with {@link TRUNCATION_MARKER}. When even the
 * criteria do not fit, trailing criteria are dropped and the body is reduced to the marker.
 */
export function truncatePrdDocument(doc: PrdDocument, allowance: number): PrdDocument {
  if (prdDocumentTokens(doc) <= allowance) return doc;
  const titleTokens = estimateTokens(doc.title);
  const markerTokens = estimateTokens(TRUNCATION_MARKER);
  let acs = [...doc.acceptanceCriteria];
  let acTokens = acs.reduce((s, a) => s + estimateTokens(a), 0);
  while (acs.length > 0 && titleTokens + acTokens + markerTokens > allowance) {
    acTokens -= estimateTokens(acs[acs.length - 1] as string);
    acs = acs.slice(0, -1);
  }
  const bodyBudget = allowance - titleTokens - acTokens - markerTokens;
  const body =
    bodyBudget > 0
      ? truncateText(doc.bodyMarkdown, fitPrefix(doc.bodyMarkdown, bodyBudget)) + TRUNCATION_MARKER
      : TRUNCATION_MARKER;
  let title = doc.title;
  if (titleTokens + acTokens + estimateTokens(body) > allowance) {
    title = truncateText(doc.title, fitPrefix(doc.title, allowance - acTokens - estimateTokens(body)));
  }
  return { ...doc, title, bodyMarkdown: body, acceptanceCriteria: acs };
}
