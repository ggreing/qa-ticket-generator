/**
 * File priority score (PRE-07):
 *
 *   score = w1·kw + w2·ln(1 + changedLines) + w3·boost − w4·penalty
 *
 * - kw      = min(KEYWORD_CAP, pathHits + CONTENT_HIT_WEIGHT · contentHits), where hits count distinct
 *             PRD keywords (from titles + acceptance criteria) found in the file path tokens, resp.
 *             only in identifiers of the changed lines / hunk headers.
 * - boost   = 1 when the path matches `scoring.boostPaths`, else 0.
 * - penalty = 1 when the path is a test file, a config file or dependency manifest (PRE-03), or
 *             matches `scoring.penalizePaths`, else 0.
 *
 * Default weights live in `src/core/config.ts` (DEFAULTS.scoring). Scores are rounded to 3
 * decimals so other implementations (Rust) reproduce them exactly.
 */
import type { PrdDocument, ScoringWeights } from '../core/contracts';
import { matchesAny } from './glob';
import { manifestKind } from './manifest';
import { isConfigPath, isTestPath } from './noise';

export const KEYWORD_CAP = 5;
export const CONTENT_HIT_WEIGHT = 0.5;
/** Body characters used for keywords when a PRD has no acceptance criteria. */
export const PRD_BODY_KEYWORD_CHARS = 2_000;

// biome-ignore format: compact word list
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'these', 'those', 'then', 'than', 'when',
  'where', 'which', 'while', 'what', 'who', 'will', 'shall', 'should', 'must', 'can', 'could', 'would', 'may',
  'might', 'not', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'does', 'did', 'done', 'all',
  'any', 'each', 'every', 'some', 'other', 'only', 'also', 'more', 'most', 'less', 'such', 'very', 'via', 'per',
  'its', 'their', 'there', 'they', 'them', 'our', 'your', 'you', 'user', 'users', 'given', 'and', 'but', 'about',
  'after', 'before', 'over', 'under', 'between', 'within', 'without', 'able', 'new', 'add', 'added', 'adds',
  'update', 'updated', 'remove', 'removed', 'change', 'changed', 'use', 'used', 'using', 'get', 'set', 'make',
  'show', 'shown', 'display', 'support', 'allow', 'allows', 'ensure', 'feature', 'page', 'button', 'data', 'value',
  'values', 'item', 'items', 'list', 'type', 'types', 'true', 'false', 'null', 'none', 'return', 'returns', 'const',
  'let', 'var', 'function', 'class', 'import', 'export', 'default', 'async', 'await', 'src', 'lib', 'index',
  'main', 'test', 'tests', 'spec', 'acceptance', 'criteria', 'scenario', 'story', 'prd', 'issue', 'http', 'https',
  'www', 'com',
]);

const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * Splits text into normalised keyword tokens: camelCase/PascalCase/snake/kebab boundaries,
 * lower-cased, a trailing plural `s` dropped, stopwords and very short tokens removed
 * (ASCII < 3 chars, other scripts < 2 chars), digits-only tokens removed.
 */
export function tokenize(text: string, out: Set<string> = new Set()): Set<string> {
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0];
    const parts = word
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
      .split(' ');
    for (const part of parts) {
      const t = normalizeToken(part);
      if (t) out.add(t);
    }
  }
  return out;
}

function normalizeToken(raw: string): string | null {
  let t = raw.toLowerCase();
  if (/^\d+$/.test(t)) return null;
  // Tokens are [\p{L}\p{N}]+ runs, so "ASCII" here means lower-case latin letters and digits.
  const ascii = /^[a-z0-9]+$/.test(t);
  if (ascii && t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (ascii ? t.length < 3 : t.length < 2) return null;
  if (STOPWORDS.has(t)) return null;
  return t;
}

/** PRD keywords: titles + acceptance criteria (body prefix when a document has no criteria). */
export function prdKeywords(docs: readonly PrdDocument[]): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    tokenize(d.title, out);
    if (d.acceptanceCriteria.length > 0) for (const ac of d.acceptanceCriteria) tokenize(ac, out);
    else tokenize(d.bodyMarkdown.slice(0, PRD_BODY_KEYWORD_CHARS), out);
  }
  return out;
}

export interface ScoreInput {
  path: string;
  previousPath?: string;
  /** additions + deletions. */
  changedLines: number;
  /** Changed lines and hunk headers, used for content keyword hits. */
  changedText: string;
}

export interface ScoreBreakdown {
  score: number;
  keyword: number;
  changeSize: number;
  boost: number;
  penalty: number;
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function scoreFile(
  file: ScoreInput,
  keywords: ReadonlySet<string>,
  weights: ScoringWeights,
): ScoreBreakdown {
  let keyword = 0;
  if (keywords.size > 0) {
    const pathTokens = tokenize(file.path);
    if (file.previousPath) tokenize(file.previousPath, pathTokens);
    let pathHits = 0;
    for (const k of keywords) if (pathTokens.has(k)) pathHits++;
    let contentHits = 0;
    if (pathHits < keywords.size && file.changedText !== '') {
      const contentTokens = tokenize(file.changedText);
      for (const k of keywords) if (!pathTokens.has(k) && contentTokens.has(k)) contentHits++;
    }
    keyword = Math.min(KEYWORD_CAP, pathHits + CONTENT_HIT_WEIGHT * contentHits);
  }
  const changeSize = Math.log(1 + Math.max(0, file.changedLines));
  const boost = weights.boostPaths.length > 0 && matchesAny(file.path, weights.boostPaths) ? 1 : 0;
  const penalized =
    isTestPath(file.path) ||
    isConfigPath(file.path) ||
    manifestKind(file.path) !== null ||
    (weights.penalizePaths.length > 0 && matchesAny(file.path, weights.penalizePaths));
  const penalty = penalized ? 1 : 0;
  const score =
    weights.prdKeyword * keyword +
    weights.changeSize * changeSize +
    weights.domainPath * boost -
    weights.testOrConfigPenalty * penalty;
  return { score: round3(score), keyword, changeSize, boost, penalty };
}

/** Changed (`+`/`-`) lines and hunk section headers of a patch body, for keyword matching. */
export function changedText(hunks: readonly { header: string; text: string }[]): string {
  const parts: string[] = [];
  for (const h of hunks) {
    parts.push(h.header);
    for (const line of h.text.split('\n')) {
      if (line[0] === '+' || line[0] === '-') parts.push(line.slice(1));
    }
  }
  return parts.join('\n');
}
