/**
 * Writing style for QA cases (SPEC v3 §3.1): the voice of a working QA sheet, not of an essay.
 *
 * The general rules are part of the system prompt. Each output language adds its own conventions,
 * the rules the style lint checks (read from `STYLE_RULES` in src/cases, so the prompt and the
 * lint cannot drift apart) and two example cases. The examples are about comments and bookmarks on
 * purpose: no eval case is about either, so they cannot hand a case its answer (a test checks it).
 * Owner: qa-work-session-c(fable).
 */
import { SPEC_GAP_PREFIX, STYLE_RULES } from '../../cases';
import type { CaseDraft } from '../../core/cases';
import type { Language } from '../../core/contracts';

/** Last line of `expected` when the spec does not say what should happen. Shared with the style lint, which allows it. */
export const SPEC_DECISION_LABEL: Readonly<Record<Language, string>> = SPEC_GAP_PREFIX;

/** Shared by every language; goes into the system prompt. */
export const STYLE_GUIDE = `# How to write a case

Write the way a QA engineer fills in a test case sheet for teammates who will run it today. A case is something to do and something to observe. It does not explain itself, argue for itself, or describe testing.

- Title: a short noun phrase naming the target, the condition and the result. It reads like a row in a sheet, not like a sentence about a test, and it fits on one line of a sheet (about 80 characters in English, 40 in Korean, Japanese or Chinese). Leave priority and technique out of it; they have their own fields.
- Preconditions: states to set up, one per line, as short as a label.
- Test data: real values, one "name = value" per line. Use the exact boundary, the exact code, the exact amount. "An invalid value" is not data.
- Steps: one short action per line, in the order they are done. Start with the action. No "first", "then", "the user should".
- Expected: facts someone can see or query, such as the message shown, the status code, the stored value, the count. The first line is the one that decides pass or fail. Do not write that something "works", "is handled" or "behaves correctly"; say what appears.
- Why it is easy to miss: one sentence of fact about the spec, usually what it does not define. Leave it empty when the spec states the case outright.
- Text that is itself input or UI copy, such as an emoji typed into a field or a greeting stored in a profile, goes in test data as "name = value" or inside quotation marks, so it reads as data and not as your wording.

Words that mark a text as written about testing instead of for testing stay out of every field: phrases like "ensure that", "verify that", "should be able to", "this test", and adverbs like "properly", "correctly", "appropriately", "seamlessly". The same goes for emoji, for a dash followed by an afterthought, and for a colon that sets up a contrast.`;

interface LanguageStyle {
  /** Conventions of QA sheets in this language. */
  conventions: string;
  /** Wording to keep out, quoted as it would appear. */
  avoid: string[];
  /** One line rewritten from essay voice to sheet voice. */
  contrast: { no: string; yes: string };
  examples: CaseDraft[];
}

const STYLES: Readonly<Record<Language, LanguageStyle>> = {
  en: {
    conventions:
      'Steps are imperatives ("Open the post", "Tap Save"). Expected results are short statements of fact in the present tense, without "should". Titles are noun phrases without a verb like "verify" or "check".',
    avoid: [
      'ensure',
      'verify that',
      'validate that',
      'should be able to',
      'properly',
      'correctly',
      'appropriately',
      'seamlessly',
      'gracefully',
      'This test',
      'This case',
    ],
    contrast: {
      no: 'Verify that the system properly rejects comments that exceed the limit',
      yes: '1,001-character comment rejected on submit',
    },
    examples: [
      {
        title: '1,000-character comment accepted on submit',
        acLabels: ['AC2'],
        technique: 'boundary',
        priority: 'P1',
        preconditions: ['Signed in', 'Post detail screen open'],
        testData: ['comment = 1,000 Latin letters'],
        steps: ['Paste the comment into the comment box', 'Tap Post'],
        expected: ['Comment appears at the top of the list', 'Counter shows 1,000/1,000'],
        whyEasyToMiss:
          'The spec says "up to 1,000 characters" without saying whether 1,000 itself is allowed.',
        origin: 'spec',
      },
      {
        title: 'Second bookmark tap on the same post adds no duplicate',
        acLabels: ['AC4'],
        technique: 'idempotency',
        priority: 'P1',
        preconditions: ['Signed in', 'Post P-100 not bookmarked'],
        testData: ['post = P-100'],
        steps: ['Tap the bookmark icon twice within one second', 'Open My bookmarks'],
        expected: [
          'P-100 not listed twice',
          'Spec decision needed: whether the second tap keeps the bookmark (1 listed) or removes it (0 listed)',
        ],
        whyEasyToMiss: 'The spec describes adding a bookmark and does not say what a repeated tap does.',
        origin: 'spec',
      },
    ],
  },
  ko: {
    conventions:
      '개조식으로 쓰고 명사형으로 끝낸다(`~시 ~됨`, `~노출`, `~불가`, `~유지`). 단계는 "~진입", "~입력 후 적용", "~탭"처럼 동작만 적는다. "~합니다", "~됩니다" 같은 서술형 종결과 "~하는지 확인"은 쓰지 않는다.',
    avoid: [
      '~를 보장',
      '~를 검증합니다',
      '~하는지 확인',
      '~할 수 있어야 합니다',
      '~해야 합니다',
      '적절히',
      '올바르게',
      '원활하게',
      '정상적으로',
      '이 테스트는',
      '이 케이스는',
    ],
    contrast: {
      no: '글자수 제한을 초과한 댓글이 올바르게 거부되는지 확인하는 테스트',
      yes: '댓글 1,001자 입력 시 등록 불가',
    },
    examples: [
      {
        title: '댓글 1,000자 입력 시 등록',
        acLabels: ['AC2'],
        technique: 'boundary',
        priority: 'P1',
        preconditions: ['로그인 상태', '게시글 상세 화면'],
        testData: ['댓글 = 한글 1,000자'],
        steps: ['댓글 입력란에 1,000자 붙여넣기', '등록 버튼 탭'],
        expected: ['댓글 목록 최상단에 등록됨', '글자수 카운터 1,000/1,000 표시'],
        whyEasyToMiss: '기획서에 "최대 1,000자"만 있고 1,000자 포함 여부 정의 없음',
        origin: 'spec',
      },
      {
        title: '같은 게시글 북마크 연속 2회 탭 시 중복 저장 없음',
        acLabels: ['AC4'],
        technique: 'idempotency',
        priority: 'P1',
        preconditions: ['로그인 상태', '게시글 P-100 북마크 안 된 상태'],
        testData: ['게시글 = P-100'],
        steps: ['북마크 아이콘 1초 안에 2회 탭', '내 북마크 목록 진입'],
        expected: [
          'P-100 2건 이상 노출 없음',
          '기획 확인 필요: 두 번째 탭 시 북마크 유지(1건) 또는 해제(0건)',
        ],
        whyEasyToMiss: '기획서에 북마크 추가만 있고 반복 탭 동작 정의 없음',
        origin: 'spec',
      },
    ],
  },
  ja: {
    conventions:
      '体言止めで書く(「〜時に〜される」ではなく「〜時 〜表示」「〜不可」「〜維持」)。手順は「〜を開く」「〜を入力して適用」のように操作だけを書く。です・ます体と「〜ことを確認する」は使わない。',
    avoid: [
      '〜を保証',
      '〜を検証します',
      '〜ことを確認',
      '〜べきです',
      '適切に',
      '正しく',
      'スムーズに',
      'このテストは',
      '本ケースは',
    ],
    contrast: {
      no: '文字数制限を超えたコメントが正しく拒否されることを確認するテスト',
      yes: 'コメント1,001文字入力時 投稿不可',
    },
    examples: [
      {
        title: 'コメント1,000文字入力時 投稿可',
        acLabels: ['AC2'],
        technique: 'boundary',
        priority: 'P1',
        preconditions: ['ログイン済み', '投稿詳細画面'],
        testData: ['コメント = 全角1,000文字'],
        steps: ['コメント欄に1,000文字を貼り付け', '投稿ボタンをタップ'],
        expected: ['コメント一覧の先頭に表示', '文字数カウンター 1,000/1,000'],
        whyEasyToMiss: '仕様書は「最大1,000文字」のみで、1,000文字ちょうどの可否が未定義',
        origin: 'spec',
      },
      {
        title: '同一投稿のブックマーク連続2回タップ時 重複登録なし',
        acLabels: ['AC4'],
        technique: 'idempotency',
        priority: 'P1',
        preconditions: ['ログイン済み', '投稿 P-100 未ブックマーク'],
        testData: ['投稿 = P-100'],
        steps: ['ブックマークアイコンを1秒以内に2回タップ', 'マイブックマーク一覧を開く'],
        expected: ['P-100 の重複表示なし', '仕様確認要: 2回目のタップでブックマーク維持(1件)か解除(0件)か'],
        whyEasyToMiss: '仕様書はブックマーク追加のみで、連続タップ時の動作が未定義',
        origin: 'spec',
      },
    ],
  },
  'zh-CN': {
    conventions:
      '用短语书写，不写完整的说明句。标题为“对象+条件+结果”，步骤只写操作（“进入帖子详情”“粘贴后点击发布”），预期结果只写可观察到的事实（“提示‘超出字数’”“列表新增1条”）。不使用“应该”“确保”“验证是否”。',
    avoid: [
      '确保',
      '验证…是否',
      '应该能够',
      '应当',
      '正确地',
      '适当地',
      '顺利地',
      '正常地',
      '本测试',
      '该用例',
    ],
    contrast: {
      no: '验证系统是否能够正确地拒绝超出字数限制的评论',
      yes: '评论输入1,001字时无法发布',
    },
    examples: [
      {
        title: '评论输入1,000字时可发布',
        acLabels: ['AC2'],
        technique: 'boundary',
        priority: 'P1',
        preconditions: ['已登录', '帖子详情页'],
        testData: ['评论 = 1,000个汉字'],
        steps: ['在评论框粘贴1,000字', '点击发布'],
        expected: ['评论显示在列表首位', '字数计数器显示 1,000/1,000'],
        whyEasyToMiss: '需求只写“最多1,000字”，未说明是否包含1,000字',
        origin: 'spec',
      },
      {
        title: '同一帖子连续点击收藏2次时不重复收藏',
        acLabels: ['AC4'],
        technique: 'idempotency',
        priority: 'P1',
        preconditions: ['已登录', '帖子 P-100 未收藏'],
        testData: ['帖子 = P-100'],
        steps: ['1秒内点击收藏图标2次', '进入我的收藏'],
        expected: ['P-100 未重复显示', '需确认需求: 第二次点击后保留收藏(1条)还是取消收藏(0条)'],
        whyEasyToMiss: '需求只描述添加收藏，未定义重复点击的行为',
        origin: 'spec',
      },
    ],
  },
};

/** The example cases for a language (also used by tests and the eval rubric). */
export const styleExamples = (language: Language): CaseDraft[] => STYLES[language].examples;
/** One line per rule the style lint checks for a language, as the prompt states them. */
export const styleRuleHints = (language: Language): string[] => [
  ...new Set(STYLE_RULES[language].map((r) => r.hint)),
];
/** Wording the stand-in lint of the eval harness looks for, per language. */
export const avoidedWording = (language: Language): string[] => STYLES[language].avoid;

function renderExample(c: CaseDraft): string {
  const lines = (label: string, items: string[]): string =>
    items.length === 0 ? '' : `${label}:\n${items.map((item) => `  - ${item}`).join('\n')}\n`;
  return (
    `title: ${c.title}\n` +
    `technique: ${c.technique}   priority: ${c.priority}   acLabels: ${c.acLabels.join(', ')}\n` +
    lines('preconditions', c.preconditions) +
    lines('testData', c.testData) +
    lines('steps', c.steps) +
    lines('expected', c.expected) +
    `whyEasyToMiss: ${c.whyEasyToMiss}`
  );
}

/**
 * The per-language part of the style guide: conventions, wording to avoid, one rewrite and two
 * example cases, all in the output language. Stable for a run, so it sits in the cached prefix.
 */
export function languageStyle(language: Language, name: string): string {
  const style = STYLES[language];
  return `# Style in ${name}

${style.conventions}

Every case is checked against these rules after you write it:
${styleRuleHints(language)
  .map((hint) => `- ${hint}`)
  .join('\n')}

Rewritten from essay voice to sheet voice:
- not: ${style.contrast.no}
- but: ${style.contrast.yes}

When the spec does not say what should happen, the expected lines hold only what must be true whichever way it is decided, and the last expected line starts with "${SPEC_DECISION_LABEL[language]}:" and names the open question with its options. A status code, error name or message the spec does not give belongs in that last line, never above it.

Two cases in the voice to use. They show the voice and the level of detail only; their subject has nothing to do with the spec you are given.

<example_case>
${renderExample(style.examples[0] as CaseDraft)}
</example_case>
<example_case>
${renderExample(style.examples[1] as CaseDraft)}
</example_case>`;
}
