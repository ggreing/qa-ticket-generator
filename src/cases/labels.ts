/**
 * Output-language labels for case text (SPEC v3 §3, §3.1). Shared with the sinks (session a) and
 * the prompts (session c) so every surface uses the same words.
 */
import type { CodeStatus, Priority, Technique } from '../core/cases';
import type { Language } from '../core/contracts';

/** Technique label shown in titles and fields, e.g. `[경계값]`. */
export const TECHNIQUE_LABELS: Record<Language, Record<Technique, string>> = {
  ko: {
    happy_path: '정상 흐름',
    boundary: '경계값',
    equivalence: '동등 분할',
    invalid_input: '잘못된 입력',
    state_transition: '상태 전이',
    permission: '권한',
    concurrency: '동시성',
    failure: '실패·타임아웃',
    idempotency: '중복·멱등성',
    compatibility: '하위 호환',
    locale_time: '시간대·로케일',
    data_integrity: '데이터 정합성',
  },
  en: {
    happy_path: 'Happy path',
    boundary: 'Boundary',
    equivalence: 'Equivalence',
    invalid_input: 'Invalid input',
    state_transition: 'State transition',
    permission: 'Permission',
    concurrency: 'Concurrency',
    failure: 'Failure/timeout',
    idempotency: 'Idempotency',
    compatibility: 'Compatibility',
    locale_time: 'Time zone/locale',
    data_integrity: 'Data integrity',
  },
  ja: {
    happy_path: '正常系',
    boundary: '境界値',
    equivalence: '同値分割',
    invalid_input: '不正入力',
    state_transition: '状態遷移',
    permission: '権限',
    concurrency: '同時実行',
    failure: '失敗・タイムアウト',
    idempotency: '重複・冪等性',
    compatibility: '後方互換',
    locale_time: 'タイムゾーン・ロケール',
    data_integrity: 'データ整合性',
  },
  'zh-CN': {
    happy_path: '正常流程',
    boundary: '边界值',
    equivalence: '等价类',
    invalid_input: '非法输入',
    state_transition: '状态迁移',
    permission: '权限',
    concurrency: '并发',
    failure: '失败/超时',
    idempotency: '重复/幂等',
    compatibility: '向后兼容',
    locale_time: '时区/本地化',
    data_integrity: '数据一致性',
  },
};

/** §4.4 — title prefix of a case the spec no longer produces: `[해당 없음][P0][경계값] …`. */
export const OBSOLETE_LABEL: Record<Language, string> = {
  ko: '해당 없음',
  en: 'Obsolete',
  ja: '対象外',
  'zh-CN': '不再适用',
};

export const CODE_STATUS_LABELS: Record<Language, Record<CodeStatus, string>> = {
  ko: {
    implemented: '구현 확인됨',
    missing: '미구현 의심',
    contradicts: '기획과 상충',
    unknown: '코드로 판단 불가',
  },
  en: {
    implemented: 'Implemented',
    missing: 'Possibly missing',
    contradicts: 'Conflicts with spec',
    unknown: 'Cannot tell from code',
  },
  ja: {
    implemented: '実装確認済み',
    missing: '未実装の疑い',
    contradicts: '仕様と矛盾',
    unknown: 'コードから判断不可',
  },
  'zh-CN': {
    implemented: '已实现',
    missing: '疑似未实现',
    contradicts: '与需求冲突',
    unknown: '无法从代码判断',
  },
};

/**
 * Prefix of the last expected line when the spec leaves the result open, e.g.
 * `기획 확인 필요: 만료 시각 포함 여부`. The style lint allows it.
 */
export const SPEC_GAP_PREFIX: Record<Language, string> = {
  ko: '기획 확인 필요',
  en: 'Spec decision needed',
  ja: '仕様確認要',
  'zh-CN': '需确认需求',
};

export interface SectionLabels {
  preconditions: string;
  testData: string;
  steps: string;
  expected: string;
  whyEasyToMiss: string;
  acLabels: string;
  codeStatus: string;
  /** Shown instead of AC labels for cases that come from the code. */
  codeOrigin: string;
}

export const SECTION_LABELS: Record<Language, SectionLabels> = {
  ko: {
    preconditions: '전제 조건',
    testData: '테스트 데이터',
    steps: '단계',
    expected: '기대 결과',
    whyEasyToMiss: '놓치기 쉬운 이유',
    acLabels: '관련 AC',
    codeStatus: '코드 상태',
    codeOrigin: '코드 출처',
  },
  en: {
    preconditions: 'Preconditions',
    testData: 'Test data',
    steps: 'Steps',
    expected: 'Expected result',
    whyEasyToMiss: 'Why it is easy to miss',
    acLabels: 'Related AC',
    codeStatus: 'Code status',
    codeOrigin: 'From the code',
  },
  ja: {
    preconditions: '前提条件',
    testData: 'テストデータ',
    steps: '手順',
    expected: '期待結果',
    whyEasyToMiss: '見落としやすい理由',
    acLabels: '関連AC',
    codeStatus: 'コード状況',
    codeOrigin: 'コード由来',
  },
  'zh-CN': {
    preconditions: '前置条件',
    testData: '测试数据',
    steps: '步骤',
    expected: '预期结果',
    whyEasyToMiss: '容易遗漏的原因',
    acLabels: '相关AC',
    codeStatus: '代码状态',
    codeOrigin: '来自代码',
  },
};

export const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2'];
