/**
 * SPEC v3 §2.2 — a deterministic safety net against a verify run proposing a case that is already
 * there in other words. The prompt is the main defence; this only catches rephrasings.
 *
 * Two cases are the same risk when their technique is the same and their titles reduce to the same
 * signature. The signature drops what rephrasing changes: word order, letter case, full-width forms,
 * Korean particles, a few function words, the outcome word at the end of the title ("… 시 처리" vs
 * "… 시 거부"), and the language of a few common condition words (invalid / 잘못된 / 不正, date /
 * 날짜 / 日付, …). Everything else must match exactly: every number with its unit, quoted value,
 * identifier, condition and target. So `30자` and `31자`, `과거 날짜` and `잘못된 날짜`, or
 * `쿠폰` and `포인트` keep two cases apart. Titles without spaces (most Japanese and Chinese titles)
 * only match when they are nearly identical, which errs on the side of keeping both cases.
 */
import type { CaseDraft } from '../core/cases';
import { plainTitle } from './render';

/** Condition words with the same meaning across languages, mapped to one token. */
const CONCEPTS: ReadonlyMap<string, string> = (() => {
  const groups: Record<string, string[]> = {
    invalid: [
      'invalid',
      'malformed',
      'wrong',
      '잘못된',
      '잘못',
      '비정상',
      '不正',
      '不正な',
      '無効',
      '無効な',
      '无效',
      '非法',
    ],
    date: ['date', '날짜', '일자', '日付', '日期'],
    empty: ['empty', 'blank', '빈', '공백', '空', '空白', '空欄'],
    expired: ['expired', '만료', '만료된', '期限切れ', '过期', '已过期'],
    duplicate: ['duplicate', 'duplicated', '중복', '중복된', '重複', '重复'],
    negative: ['negative', '음수', '負', '负数'],
    past: ['past', '과거', '過去', '过去'],
    future: ['future', '미래', '未来'],
    exceed: ['exceeds', 'exceeding', 'exceeded', '초과', '超過', '超过'],
    missing: ['missing', '누락', '누락된', '欠落', '缺失', '缺少'],
  };
  const m = new Map<string, string>();
  for (const [concept, words] of Object.entries(groups)) for (const w of words) m.set(w, `<${concept}>`);
  return m;
})();

/** Words that carry no meaning of their own in a title. */
const STOP: ReadonlySet<string> = new Set([
  '시',
  '때',
  '경우',
  '및',
  'a',
  'an',
  'the',
  'when',
  'is',
  'are',
  'be',
  '時',
  'の',
  '时',
  '的',
]);

/** How the system reacts; dropped only at the end of a title, where the result goes. */
const OUTCOME: ReadonlySet<string> = new Set([
  ...[
    'handled',
    'rejected',
    'refused',
    'denied',
    'blocked',
    'accepted',
    'allowed',
    'succeeds',
    'fails',
    'returned',
    'shown',
  ],
  ...['처리', '거부', '거절', '차단', '성공', '실패', '허용', '반환', '노출', '표시'],
  ...['処理', '拒否', '成功', '失敗', '表示'],
  ...['处理', '拒绝', '成功', '失败', '显示'],
]);

/** Korean particles, longest first; stripped only when at least two syllables remain. */
const PARTICLES = [
  '에서는',
  '에서',
  '으로',
  '에게',
  '부터',
  '까지',
  '을',
  '를',
  '이',
  '가',
  '은',
  '는',
  '에',
  '의',
  '로',
  '와',
  '과',
  '도',
];
const HANGUL_END = /[가-힣]$/;

const QUOTED = /'[^']*'|"[^"]*"|“[^”]*”|‘[^’]*’|「[^」]*」|`[^`]*`/g;

function stripParticle(word: string): string {
  if (!HANGUL_END.test(word)) return word;
  for (const p of PARTICLES) {
    if (word.endsWith(p) && [...word].length - [...p].length >= 2) return word.slice(0, -p.length);
  }
  return word;
}

function tokenOf(word: string): string | null {
  if (STOP.has(word)) return null;
  // Numbers keep their unit and separators: 30자, 1.5배, 23:59:59, 409, v1.
  if (/\p{N}/u.test(word)) return word;
  const known = CONCEPTS.get(word);
  if (known) return known;
  const stem = stripParticle(word);
  if (stem !== word) return tokenOf(stem);
  return word;
}

/** The title's signature words, in title order (see the module comment). */
export function titleTokens(title: string): string[] {
  const values: string[] = [];
  const text = plainTitle(title)
    .normalize('NFKC')
    .toLowerCase()
    .replace(QUOTED, (m) => {
      values.push(`"${m.slice(1, -1).trim()}"`);
      return ' ';
    })
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  const words: string[] = [];
  for (const raw of text.split(/[\s,;/()[\]{}~→·]+/u)) {
    const w = raw.replace(/^[^\p{L}\p{N}_$]+|[^\p{L}\p{N}_$]+$/gu, '');
    if (w === '') continue;
    const t = tokenOf(w);
    if (t !== null) words.push(t);
  }
  while (words.length > 0 && OUTCOME.has(words.at(-1) as string)) words.pop();
  return [...words, ...values];
}

/** Fewer signature words than this is too little to call two different titles the same risk. */
const MIN_TOKENS = 3;

/**
 * Key under which cases count as the same risk, or null when the title is too short to tell.
 * Equal keys mean: same technique and the same signature words (as a multiset).
 */
export function sameRiskKey(c: Pick<CaseDraft, 'title' | 'technique'>): string | null {
  const tokens = titleTokens(c.title);
  if (tokens.length < MIN_TOKENS) return null;
  return `${c.technique}\u0001${[...tokens].sort().join('\u0000')}`;
}
