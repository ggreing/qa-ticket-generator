import type { Strings } from './types';

export const ja: Strings = {
  title: 'AI QA',
  alignmentStatus: { aligned: '一致', partial: '一部一致', misaligned: '不一致', no_prd: 'PRD なし' },
  noPrd: 'リンクされた PRD がありません — コードのみから推定したシナリオです(信頼度は低め)',
  linked: 'リンク済みドキュメント',
  actionNeeded: (n) => `要対応 (${n})`,
  allCovered: (n) => `対応不要 — 要件 ${n} 件をすべて充足`,
  needsCheck: (n) => `要確認 (${n})`,
  p0Checklist: (n) => `P0 チェックリスト (${n})`,
  noP0: 'P0 シナリオなし',
  more: (n) => `ほか ${n} 件`,
  card: { given: '前提', data: 'データ', steps: '手順', expected: '期待結果', related: '関連', why: '理由' },
  confidence: '信頼度',
  level: { high: '高', medium: '中', low: '低' },
  otherTickets: (n) => `P1 · P2 チケット (${n})`,
  requirementDetails: (n) => `要件ごとの判定 (${n})`,
  sections: {
    risks: 'リスク',
    assumptions: '前提条件',
    notes: '補足',
    skippedFiles: '除外したファイル',
    redactions: 'マスクした秘密情報',
  },
  table: { requirement: '要件', status: '状態', evidence: '根拠' },
  requirementStatus: { covered: '充足', missing: '未実装', contradicts: '矛盾', unclear: '不明' },
  omittedTickets: (n) =>
    `GitHub のコメント長の上限に収めるため、優先度の低いチケット ${n} 件を省略しました。完全なレポートはワークフローの Job Summary と report.json にあります。`,
  omittedFindings: (n) =>
    `GitHub のコメント長の上限に収めるため、要件 ${n} 行を省略しました。完全なレポートはワークフローの Job Summary と report.json にあります。`,
  truncated:
    'GitHub のコメント長の上限に合わせて内容を切り詰めました。完全なレポートはワークフローの Job Summary と report.json にあります。',
  runFailed: '実行失敗',
  errorCode: 'エラーコード',
  errorHint: {
    cost_cap:
      '推定コストが `max-cost-usd` の上限を超えたため、分析は実行していません。ワークフローで `max-cost-usd` を引き上げるか、`token-budget` を下げて変更をより小さな単位で分析してください。',
  },
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
    tickets: 'チケット',
    detailsInThread: 'チケットの詳細はスレッドにあります。',
  },
};
