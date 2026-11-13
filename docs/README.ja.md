# qa-ticket-generator

[English](../README.md) | [한국어](README.ko.md) | **日本語** | [简体中文](README.zh-CN.md)

<!-- バッジ(CI、リリース、ライセンス)はリポジトリ公開時に追加します。 -->

> 🚧 pre-v0.1 です。手元のテスト用リポジトリでは動いていますが、input 名やコメントの見た目はまだ変わるかもしれません。

プルリクエストと、その PR が実装するはずのチケットをいっしょに読んで、QA 担当者が書くようなメモを残す
GitHub Action です。どの要件が実装済みで、どれが抜けているか、マージ前にどんなテストをしておくとよいかを
PR にコメントします。

## Why

小さなチームには QA 専任がいないことが多く、レビュアーも diff を見ながら Jira のチケットを横に開いている
わけではありません。その結果、レビューも通ってテストも緑なのに、一週間後に受け入れ条件がひとつ丸ごと
実装されていなかったと気づく、ということが起きます。

このアクションがその突き合わせを代わりにやります。PR の説明にチケットのリンクを書いて `needs-ai-qa`
ラベルを付けると、1〜2 分後に Claude がコードと要件を比べたコメントを残します。コードレビューのボットでは
ないので、スタイルには口を出しません。変更が仕様どおりか、それを確かめるには何をテストすべきか、だけを見ます。

## What you get

コメントはだいたいこんな形です(v0.1 に向けてまだ調整中です):

```markdown
## 🧪 AI QA — 4e2455c · ⚠️ 一部一致

**要対応 (2)**

- ❌ AC2 期限切れのクーポンは拒否する: `expiresAt` を現在時刻と比べるコードがない (`src/coupon.ts`)
- ❌ AC4 定率割引は最大 10,000 ウォン: 上限がかかっていない

**P0 チェックリスト**

- [ ] TC-01 1 秒前に期限切れになったクーポン → 拒否、使用履歴は残らない
- [ ] TC-02 同じユーザーが同じクーポンを同時に 2 回適用 → 1 回だけ成功
- [ ] TC-03 200,000 ウォンの注文に 10% クーポン → 割引は 10,000 ウォン(20,000 ではない)

<details><summary>TC-01 期限切れクーポンを拒否 [P0 · AC2]</summary>
前提: user-A は EXP1 を未使用、カート小計 30,000 ウォン
データ: code = EXP1, expiresAt = 現在 - 1 秒
手順: 1. 決済画面を開く 2. EXP1 を適用
期待: "Coupon has expired" の CouponError、(user-A, EXP1) の使用履歴なし
</details>

<details><summary>P1 / P2 ケース (9)</summary>…</details>
```

コミットを追加で push すると、新しいコメントを増やさずに同じコメントを書き換えます。lock ファイルや
ビルド成果物だけの push は無視します。Slack をつなぐと、チャンネルには短い要約、そのスレッドにテストケースが
流れます。

中の流れが気になる方はこちら。

![構成図: GitHub イベント、トリガー判定、コンテキストと PRD の収集、前処理、Claude、PR コメント・Slack・Job Summary](diagrams/architecture.png)

## Setup

必要なのは Anthropic の API キーと 5 分ほどの時間です。

1. リポジトリの secret に `ANTHROPIC_API_KEY` という名前でキーを登録します。
2. `needs-ai-qa` というラベルを作ります。
3. 次のワークフローを `.github/workflows/qa-ticket-generator.yml` として追加します。

```yaml
name: AI QA
on:
  pull_request:
    types: [labeled, synchronize, opened, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: read

concurrency:
  group: qa-ticket-generator-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  qa:
    if: contains(github.event.pull_request.labels.*.name, 'needs-ai-qa')
    runs-on: ubuntu-latest
    steps:
      # あえて actions/checkout は入れません。PR の中身は API で読みます。
      - uses: ggreing/qa-ticket-generator@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

これで終わりです。PR にラベルを付けて、コメントを待ってください。仕様が Jira や Notion にある場合や Slack
にも通知したい場合は、[`examples/workflow.yml`](examples/workflow.yml) に追加の input が全部載っています。
日本語で出力したいときは `language: ja` を 1 行足すだけです。

fork からの PR はデフォルトでスキップします。GitHub が fork の PR には secret を渡さないためです。どうしても
必要なら [`examples/workflow-fork-opt-in.yml`](examples/workflow-fork-opt-in.yml) を使えますが、先頭の
警告は必ず読んでください。

## Linking the spec

アクションは PR の説明文からチケットへのリンクを探します。

- GitHub issue: `#123`、`owner/repo#123`、issue の URL、`Closes #123`
- Jira Cloud: `https://your-site.atlassian.net/browse/PROJ-123`。`jira-project-keys` に `PROJ` を入れて
  おけば `PROJ-123` だけでも認識します
- Notion: `notion.so` または `notion.site` のページ URL

受け入れ条件は「Acceptance Criteria」(または「AC」)見出しの下のリストか、チェックリストから読みます。
そういうセクションがなければチケット本文全体から判断します。コードブロックや HTML コメントの中のリンクは
無視するので、PR テンプレートに例のリンクを書いておいても大丈夫です。すぐ使えるテンプレートもあります:
[`examples/pull_request_template.md`](examples/pull_request_template.md)。

チケットを紐づけていない場合も、コードだけを見て動き、コメントの先頭でそのことを知らせます。いっそチェックを
失敗させたいなら `require-prd: true` を使ってください。

## Running it locally

同じものを CLI としても使えます。デフォルトではレポートを表示するだけで、どこにも投稿しません。

```bash
export GITHUB_TOKEN=… ANTHROPIC_API_KEY=…
npx qa-ticket-generator run --repo owner/repo --pr 123            # ドライラン(デフォルト)
npx qa-ticket-generator run --repo owner/repo --pr 123 --format json --out report.json
npx qa-ticket-generator run --repo owner/repo --pr 123 --publish  # PR コメント / Slack に投稿
```

アクションの input はすべて大文字の環境変数としても渡せます(`JIRA_BASE_URL`、`MAX_SCENARIOS` など)。
フラグの一覧は `npx qa-ticket-generator --help` で見られます。

## What it costs

これまで試した小さな PR(変更ファイル 1〜3 個)では、Claude Opus 5.5 で 1 回あたり $0.09〜0.19、平均 $0.13
ほどで、1 分くらいかかりました。合成 PR 10 件とサンドボックスの PR 1 件で測った値なので、目安として見てください。

大きな PR は何回かに分けて呼ぶので、そのぶん高くなります。そのため実行ごとに上限があります。`max-cost-usd`
で、デフォルトは $2 です。超えそうなときは重要度の低いファイルから外し、外したものをコメントに書きます。
各実行の見積もりコストはコメントの一番下に出ます。

## Where your code goes

このアクションは PR のコードを checkout も実行もしません。diff、変更されたファイル、紐づいたチケットを
GitHub・Jira・Notion の API で読み、Anthropic の API に送ります。それ以外には送らず、テレメトリもありません。

送る前に、秘密情報らしきもの(API キー、トークン、秘密鍵、設定ファイル内のパスワード)はマスクします。
PR のタイトルと説明文も同じです。いくつマスクしたかはコメントに出ます。ログには件数とサイズだけが残り、
ファイルの中身は残りません。

知っておいてほしいことが 2 つあります。

- リポジトリの設定ファイルは base ブランチから読みます。なので PR が自分をレビューする指示を書き換えることは
  できません。モデルが書いたテキストはエスケープしてから投稿し、Slack のメンションは無効化し、リンクは
  PR・紐づいたチケット・リポジトリだけに制限します。
- 実行と実行のあいだの状態を自分のコメントの隠しブロックに保存し、自分のトークン(`github-actions[bot]`
  か、渡した PAT の持ち主)が書いたコメントだけを信用します。同じリポジトリの別のワークフローが PR 作成者の
  文章を `github-actions[bot]` 名義でそのまま投稿していると、この状態が偽装されるおそれがあります。最悪でも
  再実行がスキップされるか、別の Slack メッセージが書き換えられる程度です。

セキュリティの問題を見つけたら、公開 issue ではなく非公開で知らせてください。[`SECURITY.md`](../SECURITY.md)
を参照してください。

## Known gaps

- ワークフローを追加する*前*に開かれた PR は、ラベルを付けても何も起きないことがあります。GitHub がその PR の
  merge コミットを更新しないため、新しいワークフローが見えないからです。ブランチを更新すれば(「Update branch」
  ボタンか `gh pr update-branch <number>`)、次の push から動きます。
- Slack の incoming webhook は投稿しかできないので、実行のたびに新しいメッセージが増えます。同じメッセージの
  更新やスレッドを使いたい場合は bot トークン(`slack-bot-token` と `slack-channel`)を使ってください。
- デフォルトの `GITHUB_TOKEN` では、ほかの private リポジトリの issue は読めません。仕様が別のリポジトリに
  あるなら、PAT か GitHub App のトークンを `github-token` に渡してください。
- 今のところ Jira は Cloud のみ(Server、Data Center は非対応)、GitHub は github.com のみ(GHES は非対応)です。
- Notion のページはインテグレーションに共有しておく必要があります(ページメニュー → コネクト)。
- モデルが見るのは変更されたファイルだけです。PR が触っていないファイルで処理されている要件は「未実装」と
  出ることがあり、そうした前提はコメントの最後にまとめて書きます。

## Configuration reference

### Inputs

<!-- inputs:start -->
| Input                   | 必須 | デフォルト                        | 説明                                                                                |
| ----------------------- | ---- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `anthropic-api-key`     | ✅   | —                                 | Anthropic の API キー。                                                             |
| `github-token`          |      | `${{ github.token }}`             | PR の読み取りとコメントの書き込みに使用。                                           |
| `model`                 |      | `claude-opus-5-5`                 | Claude のモデル ID。                                                                |
| `effort`                |      | `high`                            | `low`、`medium`、`high`、`xhigh`、`max`。低いほど安くて速い。                       |
| `language`              |      | `en`                              | `en`、`ko`、`ja`、`zh-CN`(`kr`、`jp`、`cn`、`zh` も可)。                            |
| `trigger-label`         |      | `needs-ai-qa`                     | 実行を始めるラベル。                                                                |
| `rerun-on-push`         |      | `true`                            | ラベルが付いているあいだ、新しいコミットごとに再実行。                              |
| `require-prd`           |      | `false`                           | 紐づいたチケットを読めなければチェックを失敗させる。                                |
| `token-budget`          |      | `150000`                          | モデル呼び出し 1 回の入力トークン。大きな PR は複数回に分割。                       |
| `max-cost-usd`          |      | `2.00`                            | 1 回あたりのコスト上限。超える分は重要度の低いファイルから外す。                    |
| `max-scenarios`         |      | `8`                               | コメントに入れるテストケースの最大数。                                              |
| `comment-author`        |      | —                                 | 独自の GitHub App トークンを使うときだけ指定。例: `my-app[bot]`。                   |
| `pr-comment`            |      | `true`                            | PR コメントを投稿し、更新し続ける。                                                 |
| `slack-bot-token`       |      | —                                 | Slack の bot トークン(`xoxb-`)。メッセージ更新とスレッドが使える。                  |
| `slack-channel`         |      | —                                 | bot が投稿するチャンネル ID か `#名前`。                                            |
| `slack-webhook-url`     |      | —                                 | bot トークンがないときに使う incoming webhook。                                     |
| `jira-base-url`         |      | —                                 | 例: `https://acme.atlassian.net`。                                                  |
| `jira-email`            |      | —                                 | Jira アカウントのメールアドレス。                                                   |
| `jira-api-token`        |      | —                                 | Jira の API トークン。URL・メール・トークンがそろうと Jira を使う。                 |
| `jira-project-keys`     |      | —                                 | `KEY-123` だけでも認識するプロジェクトキーをカンマ区切りで。例: `PROJ,WEB`。        |
| `notion-token`          |      | —                                 | Notion のインテグレーショントークン。                                               |
| `config-path`           |      | `.github/qa-ticket-generator.yml` | リポジトリの設定ファイル。base ブランチから読む。                                   |
| `fail-on`               |      | `none`                            | 整合性が `partial` か `misaligned` ならチェックを失敗させる。                       |
| `fail-on-error`         |      | `false`                           | 内部エラーでチェックを失敗させる。デフォルトは警告のみ。                            |
| `allow-fork-prs`        |      | `false`                           | fork の PR を許可。オプトインのワークフローでのみ使ってください。                   |
| `server-fallback`       |      | `true`                            | Opus がリクエストを断ったら Anthropic が別モデルで再試行。                          |
| `mode`                  |      | `auto`                            | `auto` はイベントで判断、`plan` は仕様から QA ケースを作成、`verify` は PR を照合。 |
| `spec`                  |      | —                                 | 手動実行時の仕様: issue 番号、Jira キー、Notion URL。                               |
| `plan-label`            |      | `needs-qa-plan`                   | 計画フェーズを始める issue ラベル。                                                 |
| `sinks`                 |      | `github-issue,file`               | ケースチケットの作成先: `jira`、`github-issue`、`notion`、`file`。                  |
| `notion-qa-database-id` |      | —                                 | QA ケースを入れる Notion データベース。                                             |
| `jira-subtask-type`     |      | `Sub-task`                        | ケースのサブタスクに使う Jira 課題タイプ。                                          |
| `max-cases`             |      | `80`                              | 仕様ごとの安全上限。超えると P2 から外す。                                          |
| `dry-run`               |      | `false`                           | レポートを Job Summary にだけ書く。                                                 |
<!-- inputs:end -->

### Outputs

<!-- outputs:start -->
| Output             | 説明                                           |
| ------------------ | ---------------------------------------------- |
| `report-path`      | 結果全体が入った `report.json` のパス。        |
| `scenario-count`   | 書いたテストケースの数。                       |
| `alignment-status` | `aligned`、`partial`、`misaligned`、`no_prd`。 |
| `cost-usd`         | 今回の実行の見積もりコスト。                   |
| `skipped-reason`   | スキップした場合はその理由。                   |
<!-- outputs:end -->

### Repository config file

リポジトリに `.github/qa-ticket-generator.yml` を置くと、除外するパス、受け入れ条件が入っている Jira の
フィールド、ドメインの説明を少し、といったことを指定できます。アクションの input がこのファイルより
優先されます。完全な例は [`examples/qa-ticket-generator.yml`](examples/qa-ticket-generator.yml) にあります。

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

## Contributing

バグ報告も PR も歓迎です。テストの動かし方は [`CONTRIBUTING.md`](../CONTRIBUTING.md) にあります(テストは
実際の API を呼びません)。設計メモは [`SPEC.ko.md`](SPEC.ko.md)(今は韓国語のみ)と [`adr/`](adr/) にあります。

ライセンスは Apache-2.0 です。[LICENSE](../LICENSE) をご覧ください。
