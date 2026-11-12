import type { Strings } from './types';

export const ja: Strings = {
  title: 'AI QA シナリオ',
  alignment: 'PRD 整合性',
  alignmentStatus: { aligned: '一致', partial: '一部一致', misaligned: '不一致', no_prd: 'PRD なし' },
  noPrd: 'リンクされた PRD がありません — コードのみから推定したシナリオです(信頼度は低め)',
  linked: 'リンク済みドキュメント',
  sections: {
    alignment: 'PRD 整合性',
    scenarios: 'シナリオ',
    risks: 'リスク',
    assumptions: '前提',
    notes: '補足',
    skippedFiles: '除外したファイル',
    redactions: 'マスクした秘密情報',
  },
  table: { requirement: '要件', status: '状態', evidence: '根拠' },
  requirementStatus: { covered: '充足', missing: '未実装', contradicts: '矛盾', unclear: '不明' },
  scenarioType: { happy_path: '正常系', edge_case: '境界', negative: '異常系', regression: '回帰' },
  level: { high: '高', medium: '中', low: '低' },
  related: '関連',
  why: '理由',
  confidence: '信頼度',
  omittedScenarios: (n) =>
    `GitHub のコメント長の上限に収めるため、優先度の低いシナリオ ${n} 件を省略しました。完全なレポートはワークフローの Job Summary と report.json にあります。`,
  omittedFindings: (n) =>
    `GitHub のコメント長の上限に収めるため、要件 ${n} 行を省略しました。完全なレポートはワークフローの Job Summary と report.json にあります。`,
  truncated:
    'GitHub のコメント長の上限に合わせて内容を切り詰めました。完全なレポートはワークフローの Job Summary と report.json にあります。',
  runFailed: '実行失敗',
  errorCode: 'エラーコード',
  noFiles:
    '分析対象のロジック変更がありません — 変更ファイルはすべて除外されました(lock ファイル、自動生成コード、バイナリなど)。',
  skipped: '分析をスキップしました',
  dryRun: 'ドライラン',
  footer: {
    tokens: (i, o) => `入力 ${i} / 出力 ${o} トークン`,
    cache: (r, w) => `キャッシュ読み取り ${r}、書き込み ${w}`,
    calls: (n) => `LLM 呼び出し ${n} 回`,
    filesSkipped: (n) => `${n} ファイルを除外`,
    redactions: (n) => `秘密情報 ${n} 件をマスク`,
  },
  skipReason: {
    noise: 'ノイズ',
    binary: 'バイナリ',
    too_large: 'サイズ超過',
    patch_missing: 'diff なし',
    budget: 'トークン予算',
    cost_cap: 'コスト上限',
  },
  slack: {
    openPr: 'PR を開く',
    viewReport: 'レポート全文を見る',
    scenarios: 'シナリオ',
    topRisks: '主なリスク',
    findings: '確認が必要な要件',
    detailsInThread: 'シナリオの詳細はスレッドにあります。',
  },
};
