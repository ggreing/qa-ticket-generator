# qa-ticket-generator

[English](../README.md) | [한국어](README.ko.md) | **日本語** | [简体中文](README.zh-CN.md)

<!-- Badges (CI, release, license) are added when the repository is published. -->

> 🚧 **開発中です(pre-v0.1)。まだ利用できません。** input や出力形式は変更される可能性があります。

プルリクエストのコード変更を、リンクされた要件ドキュメント(GitHub Issues、Jira Cloud、Notion)と Claude で
照合し、BDD(Given / When / Then)形式の QA シナリオと PRD 整合性レポートを PR と Slack に公開する GitHub Action です。

## 仕組み

![アーキテクチャ: GitHub イベント → トリガーゲート → コンテキスト・PRD 取得 → 前処理 → Claude → PR コメント、Slack、Job Summary](diagrams/architecture.png)

1. **トリガー。** PR に `needs-ai-qa` ラベルを付けると実行されます。ラベルが付いている間は新しい push のたびに
   再実行します(設定可能)。ノイズファイル(lock ファイル、ビルド成果物、スナップショットなど)だけを変更した
   push はスキップします。
2. **取得と準備。** diff とリンクされた PRD を GitHub、Jira、Notion の API で読み込みます。コードを checkout する
   ことはありません。ノイズファイルを除外し、変更を囲む関数やクラスまでコンテキストを広げ(tree-sitter で
   TypeScript/TSX、JavaScript、Python、Java、Go に対応)、シークレットをマスキングし、重要なファイルからトークン予算に
   収まるよう詰めます。大きな PR は複数の部分に分けてレビューし、結果をまとめます。
3. **生成と公開。** Claude がコードと受け入れ条件(AC)を比較し、正常系・境界値・異常系のシナリオと、欠けている
   または矛盾している要件を返します。レポートは実行のたびに更新される PR コメント 1 件として投稿され、設定すれば
   Slack にも送られ、Job Summary には常に書き出されます。

## 出力例

PR コメントのイメージです(v0.1 までに実際の形式は変わる可能性があります)。出力言語は `language` input で指定します。

```markdown
## 🧪 AI QA Scenarios — `a1b2c3d` · ⚠️ PRD alignment: **Partial**

> Linked: PROJ-123 (Jira), #45 (GitHub)

### PRD Alignment

| Requirement                  | Status     | Evidence                                   |
| ---------------------------- | ---------- | ------------------------------------------ |
| AC1: クーポンは 1 回だけ適用 | ✅ covered | `CouponService.apply()` で使用済みかを確認 |
| AC3: 期限切れクーポンを拒否  | ❌ missing | 有効期限の比較処理がない (`coupon.ts`)     |

### Scenarios (12)

<details><summary><b>[P0][Edge] 有効期限の 1 秒前にクーポンを適用</b></summary>

- **Given** 有効期限が現在時刻の 1 秒後のクーポンがある
- **When** ユーザーが決済画面でクーポンを適用する
- **Then** 割引が適用される
- _Related_: AC3 · `src/coupon/coupon.ts`
</details>

### Risks

- …

<sub>model · input / output tokens · estimated cost · duration · skipped files</sub>
```

Slack の Bot モードでは、サマリーカード(整合性バッジ、シナリオ数、主なリスク、PR とレポート全文へのリンク)を投稿し、
シナリオの詳細はそのスレッドに返信します。

## クイックスタート

1. リポジトリの Secret に `ANTHROPIC_API_KEY` を登録します。任意: `SLACK_BOT_TOKEN`、`JIRA_API_TOKEN`、`NOTION_TOKEN`。
2. リポジトリに `needs-ai-qa` ラベルを作成します。
3. [`examples/workflow.yml`](examples/workflow.yml) を `.github/workflows/qa-ticket-generator.yml` にコピーし、
   使わない Slack・Jira・Notion の input を削除します。

あとは PR にラベルを付けるだけです。`actions/checkout` は**追加しないでください**。この Action はすべてを API で
読み込みます。fork からの PR は既定でスキップします。オプトインの方法と注意点は
[`examples/workflow-fork-opt-in.yml`](examples/workflow-fork-opt-in.yml) を参照してください。

## Inputs と Outputs

### Inputs

<!-- inputs:start -->
| Input               | 必須 | 既定値                            | 説明                                                                                          |
| ------------------- | ---- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `anthropic-api-key` | ✅   | —                                 | Anthropic API キー。                                                                          |
| `github-token`      |      | `${{ github.token }}`             | PR の読み取りとレポートコメントの書き込みに使うトークン。                                     |
| `model`             |      | `claude-opus-5-5`                 | Claude のモデル ID。                                                                          |
| `effort`            |      | `high`                            | 推論の深さ: `low`、`medium`、`high`、`xhigh`、`max`。                                         |
| `language`          |      | `en`                              | 出力言語: `en`、`ko`、`ja`、`zh-CN`(別名 `kr`、`jp`、`cn`、`zh`)。                            |
| `trigger-label`     |      | `needs-ai-qa`                     | 実行を依頼するラベル。                                                                        |
| `rerun-on-push`     |      | `true`                            | ラベルが付いている間、新しいコミットで再実行する。                                            |
| `require-prd`       |      | `false`                           | リンクされた PRD を 1 件も取得できなければ失敗にする。                                        |
| `token-budget`      |      | `150000`                          | LLM 呼び出し 1 回あたりの入力トークン予算(推定)。超える PR は Map-Reduce で分割。             |
| `max-cost-usd`      |      | `2.00`                            | 1 回の実行の推定コスト上限(USD)。超えると優先度の低いファイルから除外。                       |
| `max-scenarios`     |      | `20`                              | レポートに含めるシナリオの最大数。                                                            |
| `comment-author`    |      | —                                 | レポートコメントを書く login。カスタム GitHub App トークンの場合のみ指定(例: `my-app[bot]`)。 |
| `pr-comment`        |      | `true`                            | レポートを PR コメントとして公開する(同じコメントを更新)。                                    |
| `slack-bot-token`   |      | —                                 | Slack Bot トークン(`xoxb-`)。指定すると Bot モード(更新 + スレッド)。                         |
| `slack-channel`     |      | —                                 | Bot モードのチャンネル ID または `#名前`。                                                    |
| `slack-webhook-url` |      | —                                 | Slack Incoming Webhook URL。Bot トークンがない場合に使用。                                    |
| `jira-base-url`     |      | —                                 | Jira Cloud のサイト URL(例: `https://acme.atlassian.net`)。                                   |
| `jira-email`        |      | —                                 | API トークン認証に使う Jira アカウントのメールアドレス。                                      |
| `jira-api-token`    |      | —                                 | Jira API トークン。URL・メールアドレス・トークンがすべて揃うと Jira が有効になる。            |
| `jira-project-keys` |      | —                                 | PR 本文でキーだけを書いても認識するプロジェクトキー(カンマ区切り、例: `PROJ,WEB`)。           |
| `notion-token`      |      | —                                 | Notion インテグレーションのトークン。                                                         |
| `config-path`       |      | `.github/qa-ticket-generator.yml` | リポジトリ設定ファイル。base ブランチから読み込む。                                           |
| `fail-on`           |      | `none`                            | PRD 整合性が基準を下回るとチェックを失敗にする: `none`、`partial`、`misaligned`。             |
| `fail-on-error`     |      | `false`                           | 内部エラー時にチェックを失敗にする(既定は警告のみ)。                                          |
| `allow-fork-prs`    |      | `false`                           | fork からの PR の実行を許可(`pull_request_target` のオプトインワークフロー専用)。             |
| `server-fallback`   |      | `true`                            | Anthropic のサーバー側 refusal フォールバックを使う。                                         |
| `dry-run`           |      | `false`                           | 公開せず、Job Summary にのみレポートを書き出す。                                              |
<!-- inputs:end -->

`comment-author` は `GITHUB_TOKEN` と個人アクセストークン(PAT)なら自動で検出します。

### Outputs

<!-- outputs:start -->
| Output             | 説明                                                      |
| ------------------ | --------------------------------------------------------- |
| `report-path`      | `report.json` のパス。                                    |
| `scenario-count`   | 生成されたシナリオ数。                                    |
| `alignment-status` | `aligned`、`partial`、`misaligned`、`no_prd` のいずれか。 |
| `cost-usd`         | この実行の推定コスト(USD)。                               |
| `skipped-reason`   | スキップした場合はその理由。                              |
<!-- outputs:end -->

## PRD のリンク方法

PR 本文に要件ドキュメントへのリンクを書きます。

| ソース       | 認識するパターン                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| GitHub Issue | `#123`、`owner/repo#123`、`https://github.com/owner/repo/issues/123`、`Closes #123` / `Fixes` / `Resolves` |
| Jira Cloud   | `https://<site>.atlassian.net/browse/KEY-123`、および `KEY` が `jira-project-keys` にある場合の `KEY-123`  |
| Notion       | `https://www.notion.so/…<32 桁の hex ID>`、`https://<workspace>.notion.site/…<32 桁の hex ID>`             |

- ドキュメントは最大 5 件(設定可能)まで、本文に出てきた順に使います。重複は無視します。
- HTML コメントとコードブロック内のリンクは無視するので、PR テンプレートの記入例が誤って拾われることはありません。
  すぐ使えるテンプレート: [`examples/pull_request_template.md`](examples/pull_request_template.md)。
- 受け入れ条件は「Acceptance Criteria」(または「AC」)見出しの下のリスト、またはチェックボックスのリストから
  読み取ります。見つからなければ Claude がドキュメント本文から要件を解釈します。
- PRD がリンクされていない場合はコードのみで分析するモードで続行し、レポートに信頼度が低いことを表示します。
  失敗にしたい場合は `require-prd: true` を設定してください。

## リポジトリ設定ファイル

任意の `.github/qa-ticket-generator.yml` で、フィルタ、PRD 設定、スコアリング、プロンプトへの指示を調整できます。
このファイルは常に **base** ブランチから読み込むため、PR が自分自身への指示を書き換えることはできません。
優先順位: action input > このファイル > 既定値。例: [`examples/qa-ticket-generator.yml`](examples/qa-ticket-generator.yml)。

```yaml
filters:
  exclude: ["**/*.snap", "src/generated/**"]
prd:
  jiraProjectKeys: [PROJ, WEB]
  jiraAcceptanceCriteriaField: customfield_10042
prompt:
  extraInstructions: |
    Partial refunds are supported.
```

## CLI

同じパイプラインをローカルで実行できます。既定は dry-run で、レポートを表示するだけで何も公開しません。

```bash
export GITHUB_TOKEN=… ANTHROPIC_API_KEY=…
npx qa-ticket-generator run --repo owner/repo --pr 123            # dry run (default)
npx qa-ticket-generator run --repo owner/repo --pr 123 --format json --out report.json
npx qa-ticket-generator run --repo owner/repo --pr 123 --publish  # write the PR comment / Slack message
```

そのほかの設定は、action input と同じ名前の大文字の環境変数で指定します(例: `JIRA_BASE_URL`、`NOTION_TOKEN`、
`MAX_SCENARIOS`)。すべてのオプションは `npx qa-ticket-generator --help` で確認できます。

## コスト

- 実行ごとに推定コスト上限 `max-cost-usd`(既定 **$2.00**)があります。Claude を呼び出す前にコストを見積もり、
  上限を超える場合は優先度の低いファイルから除外します。除外したファイルはレポートに表示します。
- `token-budget` は LLM 呼び出し 1 回の入力を制限します(既定 150,000 トークン)。それより大きい PR は分割します。リンクされた
  PRD が使うのはこの予算の 30% までです。
- 2026-11-12 に Claude Opus 5.5、`effort: high` で**小さな PR**(合成 PR 10 件とサンドボックスの PR 1 件、PR あたり変更
  ファイル 1〜3 個、実行あたり LLM 呼び出し 1 回)を実測したところ、1 回あたり約 **$0.09〜$0.19、平均 $0.13**、所要時間は
  約 50〜70 秒でした。大きな PR は呼び出しが複数に分かれるため費用が増えることがあり、`max-cost-usd`(既定 $2.00)が
  すべての実行の上限になります。実行ごとの推定コストはレポートのフッターに表示されます。
- ノイズファイルだけを変更した push では Claude を呼び出しません。

## セキュリティとデータの流れ

- **checkout しません。** PR のコードを checkout も実行もせず、すべてを API で読み込みます。
- **fork からの PR は既定でスキップします。** ドキュメントにある `pull_request_target` のオプトインは、メンテナーが
  ラベルを付けたときにだけ実行されます。
- **シークレットをマスキングします。** モデルに送る前に diff、ファイル内容、PRD、PR のタイトルと本文から
  シークレットを伏せ、その件数をレポートに表示します。トークンはログで伏せられ、ログにはサイズと件数だけが残ります。
- **コードと PRD は Anthropic API にだけ送信します。** テレメトリーはありません。
- **設定は base ブランチから読み込み**、モデルの出力はデータとしてのみ扱います。HTML をエスケープし、Slack の
  メンションを無効化し、リンクは PR、PRD の原文、リポジトリに限定します。
- **信頼するコメントの作成者。** トークンの作成者(`github-actions[bot]` または PAT の所有者)が書いたレポートコメント
  だけを信頼します。同じリポジトリの別のワークフローが PR 作成者の入力をそのまま `github-actions[bot]` 名義で
  コメントすると隠し state を偽造できますが、影響は push 時の再実行判定と、更新する Slack メッセージの選択に限られます。
- 例にある最小限の権限を使ってください: `contents: read`、`pull-requests: write`、`issues: read`。

脆弱性は [`SECURITY.md`](../SECURITY.md) の手順に従って非公開で報告してください。

## FAQ と制約

- **Slack の Webhook モード**では、実行ごとにサマリーカードを 1 件新しく送ります。前のメッセージの更新とスレッドでの
  詳細には Bot モード(`slack-bot-token` + `slack-channel`)が必要です。
- **別の private リポジトリの Issue** は既定の `GITHUB_TOKEN` では読めません。個人アクセストークン(PAT)か
  GitHub App のトークンを `github-token` に渡してください。それまではレポートに権限の警告が表示されます。
- **Jira Cloud のみ対応です。** v1 は Jira Server と Data Center に対応していません。
- **Notion のページ**はインテグレーションに共有する必要があります(ページのメニュー → コネクト)。
- 現在は **github.com のみ**に対応しています。GitHub Enterprise Server にはまだ対応していません。

## コントリビューションとライセンス

コントリビューションを歓迎します。[`CONTRIBUTING.md`](../CONTRIBUTING.md) と[行動規範](../CODE_OF_CONDUCT.md)を
参照してください。設計ドキュメント: [`SPEC.ko.md`](SPEC.ko.md)(韓国語) · [`adr/`](adr/) · [`DEVELOPMENT.md`](DEVELOPMENT.md)。

[Apache-2.0](../LICENSE) ライセンスです。
