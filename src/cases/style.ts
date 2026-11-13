/**
 * §3.1 — deterministic "AI style" lint for case text. The same rule list feeds the generation
 * prompt (session c reads `hint`), so the prompt and the metric never drift apart.
 *
 * Every rule is a global regex applied to single-line field values. Rules marked `outsideQuotes`
 * ignore quoted UI copy ("…", '…', “…”, 「…」, 『…』), because a test may legitimately quote an
 * error message that contains a banned word.
 */
import type { CaseDraft, LintCaseStyle } from '../core/cases';
import type { Language } from '../core/contracts';

export type CaseTextField = 'title' | 'preconditions' | 'testData' | 'steps' | 'expected' | 'whyEasyToMiss';

export interface StyleRule {
  /** Violation id, e.g. `vague-adverb`. */
  rule: string;
  /** Global regex; each match is one violation. */
  pattern: RegExp;
  fields: readonly CaseTextField[];
  /** One-line instruction for prompts (English). */
  hint: string;
  /**
   * Ignore quoted UI copy and, in preconditions and test data, the value after `=` (data such as
   * `기존 bio = 안녕하세요` is input, not wording).
   */
  outsideQuotes?: boolean;
  /** Extra check on a match; only matches for which it returns true count. */
  confirm?: (match: string) => boolean;
}

const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x11ff) ||
  (code >= 0x2e80 && code <= 0x9fff) ||
  (code >= 0xac00 && code <= 0xd7af) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xff00 && code <= 0xffef);

/**
 * Title length as a reader sees it in a CJK sheet: Hangul, kana, Han and full-width characters
 * count 1, everything else (Latin letters in identifiers, digits, spaces) counts 1/2.
 */
export function displayLength(text: string): number {
  let n = 0;
  for (const ch of text) n += isWide(ch.codePointAt(0) as number) ? 1 : 0.5;
  return n;
}

const ALL: readonly CaseTextField[] = [
  'title',
  'preconditions',
  'testData',
  'steps',
  'expected',
  'whyEasyToMiss',
];
const PROSE: readonly CaseTextField[] = ['title', 'preconditions', 'steps', 'expected', 'whyEasyToMiss'];
const SENTENCES: readonly CaseTextField[] = ['preconditions', 'steps', 'expected', 'whyEasyToMiss'];
const TITLE: readonly CaseTextField[] = ['title'];

/**
 * Rules every language shares. `maxTitle` is the title limit; with `wide` (ko, ja, zh-CN) it is
 * measured with {@link displayLength}, otherwise in characters.
 */
function common(maxTitle: number, wide: boolean): StyleRule[] {
  return [
    {
      rule: 'emoji',
      pattern: /\p{Extended_Pictographic}/gu,
      // Test data may need emoji (length counting, ZWJ sequences); quoted input is fine elsewhere.
      fields: PROSE,
      hint: 'No emoji in the wording; when a test needs emoji as input, put it in quotes or test data.',
      outsideQuotes: true,
    },
    {
      rule: 'dash-explanation',
      pattern: /—|\s–\s|\s--\s/g,
      fields: PROSE,
      hint: 'No dash (—, –) used to tack an explanation onto a line.',
      outsideQuotes: true,
    },
    {
      rule: 'title-label',
      pattern: /^\s*[[［【][^\]］】]{1,20}[\]］】]/g,
      fields: TITLE,
      hint: 'Do not put [P0] or technique labels in the title; they are added automatically.',
    },
    {
      rule: 'title-colon',
      // A colon between digits is a time or a ratio (23:59:30, 1:1), not a "label: text" title.
      pattern: /(?<!\d)[:：]\s*\S|(?<=\d)[:：](?!\d)/g,
      fields: TITLE,
      hint: 'Title is one noun phrase (target + condition + result), with no colon (times like 23:59 are fine).',
    },
    {
      rule: 'title-too-long',
      pattern: new RegExp(`^[\\s\\S]{${maxTitle + 1},}$`, 'gu'),
      fields: TITLE,
      hint: wide
        ? `Keep the title within ${maxTitle} characters (Latin letters, digits and spaces count half).`
        : `Keep the title within ${maxTitle} characters.`,
      ...(wide ? { confirm: (m: string) => displayLength(m) > maxTitle } : {}),
    },
    {
      rule: 'why-multi-sentence',
      // A period ends a sentence only before a space (not in 1.5, v2.3 or file.ts).
      pattern: /[.!?](?=\s+\S)|[。！？](?=\s*\S)/g,
      fields: ['whyEasyToMiss'],
      hint: 'whyEasyToMiss is one factual sentence about what the spec leaves out.',
      outsideQuotes: true,
    },
  ];
}

export const STYLE_RULES: Record<Language, readonly StyleRule[]> = {
  ko: [
    ...common(40, true),
    {
      rule: 'guarantee',
      pattern:
        /[을를]\s*보장(?=\s*$|[\s.,)])|보장(?:합니다|한다|하는지|해야|하도록|하기|되는지|되어야|된다|됩니다|됨|돼야|되도록)/g,
      fields: ALL,
      hint: 'Do not use 보장 as a verb ("…를 보장", "보장합니다"); write the observable result. Nouns like "보장 기간" are fine.',
      outsideQuotes: true,
    },
    {
      rule: 'verify-claim',
      pattern: /(?:검증|확인)(?:합니다|한다|하는\s*(?:테스트|케이스))/g,
      fields: ALL,
      hint: 'Do not write "검증합니다", "확인합니다" or "확인하는 테스트".',
      outsideQuotes: true,
    },
    {
      rule: 'whether-check',
      pattern: /(?:는지|은지|인지|던지)\s*(?:확인|검증|체크)/g,
      fields: ['title', 'expected'],
      hint: 'Titles and expected results state the outcome, not "~하는지 확인".',
      outsideQuotes: true,
    },
    {
      rule: 'vague-adverb',
      pattern: /적절(?:히|하게)|올바르게|올바른지|원활(?:히|하게)|정상적으로/g,
      fields: ALL,
      hint: 'No vague adverbs: 적절히, 올바르게, 원활하게, 정상적으로. Name the observable result.',
      outsideQuotes: true,
    },
    {
      rule: 'must-be-able',
      pattern: /수\s*있어야\s*(?:합니다|한다|함|됨)/g,
      fields: ALL,
      hint: 'Do not write "~할 수 있어야 합니다".',
      outsideQuotes: true,
    },
    {
      rule: 'should-statement',
      pattern: /(?:해야|되어야|돼야|하여야)\s*(?:합니다|한다|함)/g,
      fields: PROSE,
      hint: 'No "~해야 합니다" statements; steps are short actions, expected results are facts.',
      outsideQuotes: true,
    },
    {
      rule: 'meta-reference',
      pattern: /이\s*(?:테스트|케이스|시나리오)(?:는|에서는|에서|를|은)/g,
      fields: ALL,
      hint: 'Do not talk about the case itself ("이 테스트는", "이 케이스는").',
      outsideQuotes: true,
    },
    {
      rule: 'title-test-word',
      pattern: /(?:테스트|검증|시나리오)\s*$/g,
      fields: TITLE,
      hint: 'Do not end the title with 테스트, 검증 or 시나리오.',
    },
    {
      rule: 'polite-ending',
      pattern: /(?:니다|세요|어요|아요|해요|예요|에요)\s*[.!]?\s*$/g,
      fields: SENTENCES,
      hint: 'Use 개조식 noun endings (~됨, ~노출, ~불가), not 합쇼체 sentences (~합니다, ~됩니다).',
      outsideQuotes: true,
    },
    {
      rule: 'step-sequencer',
      pattern:
        /^(?:먼저|우선|그다음|그 다음|다음으로|마지막으로)\s|^(?:사용자|고객|시스템|관리자)(?:는|가|이)\s/g,
      fields: ['steps'],
      hint: 'Steps are short actions without sequencers or a subject (no 먼저, 그다음, 사용자는).',
      outsideQuotes: true,
    },
    {
      rule: 'importance-claim',
      pattern: /매우\s*중요|중요한\s*(?:테스트|케이스|경계|시나리오)|핵심적인/g,
      fields: ALL,
      hint: 'Priority and technique are labels only; do not explain how important the case is.',
      outsideQuotes: true,
    },
  ],
  en: [
    ...common(80, false),
    {
      rule: 'ensure',
      pattern: /\bensur(?:e|es|ed|ing)\b/gi,
      fields: ALL,
      hint: 'Do not write "ensure"; state what is observed.',
      outsideQuotes: true,
    },
    {
      rule: 'verify-claim',
      pattern: /\b(?:verif(?:y|ies)|validat(?:e|es))\s+(?:that|whether|if)\b/gi,
      fields: ALL,
      hint: 'Do not write "verify that" or "validate that".',
      outsideQuotes: true,
    },
    {
      rule: 'vague-adverb',
      pattern: /\b(?:properly|correctly|appropriately|seamlessly|gracefully|as expected)\b/gi,
      fields: ALL,
      hint: 'No vague adverbs: properly, correctly, appropriately, seamlessly, gracefully, as expected.',
      outsideQuotes: true,
    },
    {
      rule: 'must-be-able',
      pattern: /\bshould be able to\b/gi,
      fields: ALL,
      hint: 'Do not write "should be able to".',
      outsideQuotes: true,
    },
    {
      rule: 'should-statement',
      pattern: /\b(?:should|must)\b/gi,
      fields: ['steps'],
      hint: 'Steps are imperative actions ("Open checkout"), not "should" statements.',
      outsideQuotes: true,
    },
    {
      rule: 'make-sure',
      pattern: /\bmake sure\b/gi,
      fields: ALL,
      hint: 'Do not write "make sure".',
      outsideQuotes: true,
    },
    {
      rule: 'meta-reference',
      pattern: /\bthis (?:test|case|scenario)\b/gi,
      fields: ALL,
      hint: 'Do not talk about the case itself ("This test …").',
      outsideQuotes: true,
    },
    {
      rule: 'title-test-word',
      pattern: /^(?:test|verify|validate|ensure|check)\b|\btest(?:s|ing)?\s*$/gi,
      fields: TITLE,
      hint: 'Do not start the title with Test/Verify/Check or end it with "test".',
    },
    {
      rule: 'step-not-imperative',
      pattern:
        /^(?:the\s+)?(?:user|system|customer|tester|admin)\s+(?:should|will|can|is|navigates|clicks|opens|enters|goes|selects|types)\b|^(?:first|then|next|finally)\b[,\s]/gi,
      fields: ['steps'],
      hint: 'Start each step with a verb ("Open …", "Enter …"), not "The user …" or "Then …".',
      outsideQuotes: true,
    },
    {
      rule: 'importance-claim',
      pattern: /\b(?:crucial|very important|it is important|critical to)\b/gi,
      fields: ALL,
      hint: 'Priority and technique are labels only; do not explain how important the case is.',
      outsideQuotes: true,
    },
  ],
  ja: [
    ...common(40, true),
    {
      rule: 'guarantee',
      pattern: /保証(?:します|する|される|されている|されること|できる)/g,
      fields: ALL,
      hint: 'Do not use 保証 as a verb; write the observable result.',
      outsideQuotes: true,
    },
    {
      rule: 'verify-claim',
      pattern: /(?:検証|確認)(?:します|する(?:テスト|ケース))/g,
      fields: ALL,
      hint: 'Do not write 「検証します」「確認します」「確認するテスト」.',
      outsideQuotes: true,
    },
    {
      rule: 'vague-adverb',
      pattern: /適切に|正しく|スムーズに|円滑に/g,
      fields: ALL,
      hint: 'No vague adverbs: 適切に, 正しく, スムーズに, 円滑に.',
      outsideQuotes: true,
    },
    {
      rule: 'must-be-able',
      pattern: /できる必要があ(?:ります|る)|できなければな(?:りません|らない)/g,
      fields: ALL,
      hint: 'Do not write 「〜できる必要があります」.',
      outsideQuotes: true,
    },
    {
      rule: 'should-statement',
      pattern: /する必要があります|しなければなりません|べきです/g,
      fields: PROSE,
      hint: 'No 「〜する必要があります」 statements; steps are short actions.',
      outsideQuotes: true,
    },
    {
      rule: 'meta-reference',
      pattern: /この(?:テスト|ケース|シナリオ)(?:は|では|で)/g,
      fields: ALL,
      hint: 'Do not talk about the case itself (「このテストは」).',
      outsideQuotes: true,
    },
    {
      rule: 'title-test-word',
      pattern: /(?:テスト|検証)\s*$/g,
      fields: TITLE,
      hint: 'Do not end the title with テスト or 検証.',
    },
    {
      rule: 'polite-ending',
      pattern: /(?:です|ます|ました|ません|でした|ください)\s*[。.]?\s*$/g,
      fields: SENTENCES,
      hint: 'Use 体言止め / 「〜されること」, not です・ます sentences.',
      outsideQuotes: true,
    },
    {
      rule: 'step-sequencer',
      pattern: /^(?:まず|次に|その後|最後に)|^(?:ユーザー|システム|管理者)(?:は|が)/g,
      fields: ['steps'],
      hint: 'Steps are short actions without sequencers or a subject (no まず, 次に, ユーザーは).',
      outsideQuotes: true,
    },
    {
      rule: 'importance-claim',
      pattern: /非常に重要|極めて重要|重要な(?:テスト|ケース)/g,
      fields: ALL,
      hint: 'Priority and technique are labels only; do not explain how important the case is.',
      outsideQuotes: true,
    },
  ],
  'zh-CN': [
    ...common(40, true),
    {
      rule: 'ensure',
      pattern: /确保/g,
      fields: ALL,
      hint: 'Do not write 确保; state what is observed.',
      outsideQuotes: true,
    },
    {
      rule: 'guarantee',
      pattern: /保证(?![金期书人])/g,
      fields: ALL,
      hint: 'Do not use 保证 as a verb (保证金/保证期 are fine).',
      outsideQuotes: true,
    },
    {
      rule: 'verify-claim',
      pattern: /验证.{0,20}?是否/g,
      fields: ALL,
      hint: 'Do not write 验证…是否; write the expected fact.',
      outsideQuotes: true,
    },
    {
      rule: 'must-be-able',
      pattern: /应该能够|应当能够|需要能够/g,
      fields: ALL,
      hint: 'Do not write 应该能够.',
      outsideQuotes: true,
    },
    {
      rule: 'should-statement',
      pattern: /(?:应该|应当)(?!能够)/g,
      fields: ['steps', 'expected'],
      hint: 'Steps are actions and expected results are facts, without 应该.',
      outsideQuotes: true,
    },
    {
      rule: 'vague-adverb',
      pattern: /正确地|适当地|恰当地|顺利地|顺畅地|正常地/g,
      fields: ALL,
      hint: 'No vague adverbs: 正确地, 适当地, 顺利地, 正常地.',
      outsideQuotes: true,
    },
    {
      rule: 'meta-reference',
      pattern: /(?:本|此|该)(?:测试|用例|场景)/g,
      fields: ALL,
      hint: 'Do not talk about the case itself (本测试, 该用例).',
      outsideQuotes: true,
    },
    {
      rule: 'title-test-word',
      pattern: /(?:测试|验证)\s*$/g,
      fields: TITLE,
      hint: 'Do not end the title with 测试 or 验证.',
    },
    {
      rule: 'step-sequencer',
      pattern: /^(?:首先|然后|接着|随后|最后)|^(?:用户|系统|管理员)(?:会|将|需要|应该)?(?=\S)/g,
      fields: ['steps'],
      hint: 'Steps are short actions without sequencers or a subject (no 首先, 然后, 用户).',
      outsideQuotes: true,
    },
    {
      rule: 'importance-claim',
      pattern: /非常重要|至关重要|重要的(?:测试|用例)/g,
      fields: ALL,
      hint: 'Priority and technique are labels only; do not explain how important the case is.',
      outsideQuotes: true,
    },
  ],
};

/** Quoted UI copy is replaced by spaces so phrase rules do not fire inside it. */
const QUOTED = /"[^"]*"|(?<![A-Za-z])'[^']*'(?![A-Za-z])|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/g;

function maskQuotes(text: string): string {
  return text.replace(QUOTED, (m) => ' '.repeat(m.length));
}

/** In data-carrying fields, `name = value` holds input data: the value is not wording. */
const DATA_FIELDS: ReadonlySet<CaseTextField> = new Set(['preconditions', 'testData']);

function maskData(text: string, field: CaseTextField): string {
  if (!DATA_FIELDS.has(field)) return text;
  const eq = text.indexOf('=');
  return eq < 0 ? text : text.slice(0, eq + 1) + ' '.repeat(text.length - eq - 1);
}

function valuesOf(c: CaseDraft, field: CaseTextField): string[] {
  switch (field) {
    case 'title':
      return [c.title];
    case 'whyEasyToMiss':
      return [c.whyEasyToMiss];
    default:
      return c[field];
  }
}

const FIELD_ORDER: readonly CaseTextField[] = ALL;

/**
 * §3.1 — style violations of one case, in field order (title, preconditions, test data, steps,
 * expected, why-easy-to-miss), then rule order, then position. Pure and deterministic.
 */
export const lintCaseStyle: LintCaseStyle = (c, language) => {
  const rules = STYLE_RULES[language];
  const out: { rule: string; text: string }[] = [];
  for (const field of FIELD_ORDER) {
    for (const raw of valuesOf(c, field)) {
      const text = (raw ?? '').replace(/\s+/g, ' ').trim();
      if (text === '') continue;
      const masked = maskData(maskQuotes(text), field);
      for (const r of rules) {
        if (!r.fields.includes(field)) continue;
        for (const m of (r.outsideQuotes ? masked : text).matchAll(r.pattern)) {
          if (r.confirm && !r.confirm(m[0])) continue;
          out.push({ rule: r.rule, text: m[0].trim() || m[0] });
        }
      }
    }
  }
  return out;
};
