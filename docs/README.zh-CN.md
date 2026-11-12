# qa-ticket-generator

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

<!-- Badges (CI, release, license) are added when the repository is published. -->

> 🚧 **正在开发中(pre-v0.1),暂不可用。** input 和输出格式可能还会变化。

这是一个 GitHub Action:用 Claude 将 Pull Request 的代码变更与关联的需求文档(GitHub Issues、Jira Cloud、Notion)
进行交叉校验,并把 BDD(Given / When / Then)格式的 QA 场景和 PRD 一致性报告发布到 PR 和 Slack。

## 工作原理

![架构:GitHub 事件 → 触发判定 → 上下文与 PRD 获取 → 预处理 → Claude → PR 评论、Slack、Job Summary](diagrams/architecture.png)

1. **触发。** 给 PR 添加 `needs-ai-qa` 标签即开始运行;标签保留期间,每次新的 push 都会重新运行(可配置)。
   只改动噪声文件(lock 文件、构建产物、快照等)的 push 会被跳过。
2. **获取与准备。** 通过 GitHub、Jira、Notion 的 API 读取 diff 和关联的 PRD,从不 checkout 你的代码。
   去掉噪声文件,把上下文扩展到包含变更的函数或类(通过 tree-sitter 支持 TypeScript/TSX、JavaScript、Python、Java、Go),
   对密钥脱敏,并按重要程度把文件装入 token 预算。大型 PR 会被拆成几部分分别审查,再合并结果。
3. **生成与发布。** Claude 将代码与验收标准(AC)对比,返回正常路径、边界和异常场景,以及缺失或矛盾的需求。
   报告以一条 PR 评论发布并在每次运行时更新,可选发送到 Slack,并始终写入 Job Summary。

## 输出示例

PR 评论的示意图(v0.1 之前实际格式可能变化)。输出语言由 `language` input 指定。

```markdown
## 🧪 AI QA Scenarios — `a1b2c3d` · ⚠️ PRD alignment: **Partial**

> Linked: PROJ-123 (Jira), #45 (GitHub)

### PRD Alignment

| Requirement            | Status     | Evidence                               |
| ---------------------- | ---------- | -------------------------------------- |
| AC1:优惠券只能使用一次 | ✅ covered | `CouponService.apply()` 检查是否已使用 |
| AC3:拒绝过期优惠券     | ❌ missing | 没有比较有效期的逻辑 (`coupon.ts`)     |

### Scenarios (12)

<details><summary><b>[P0][Edge] 在过期前 1 秒使用优惠券</b></summary>

- **Given** 有一张 1 秒后过期的优惠券
- **When** 用户在结算页面使用该优惠券
- **Then** 折扣生效
- _Related_: AC3 · `src/coupon/coupon.ts`
</details>

### Risks

- …

<sub>model · input / output tokens · estimated cost · duration · skipped files</sub>
```

在 Slack Bot 模式下,会发布一张摘要卡片(一致性徽章、场景数量、主要风险、PR 与完整报告的链接),
场景详情以回复形式发在该消息的线程中。

## 快速开始

1. 在仓库 Secret 中添加 `ANTHROPIC_API_KEY`。可选:`SLACK_BOT_TOKEN`、`JIRA_API_TOKEN`、`NOTION_TOKEN`。
2. 在仓库中创建 `needs-ai-qa` 标签。
3. 把 [`examples/workflow.yml`](examples/workflow.yml) 复制为 `.github/workflows/qa-ticket-generator.yml`,
   并删除不使用的 Slack、Jira、Notion input。

之后给 PR 添加标签即可。**不要**添加 `actions/checkout`,该 Action 通过 API 读取所有内容。来自 fork 的 PR 默认跳过;
如需启用及其注意事项,请参阅 [`examples/workflow-fork-opt-in.yml`](examples/workflow-fork-opt-in.yml)。

## Inputs 与 Outputs

### Inputs

<!-- inputs:start -->
| Input               | 必填 | 默认值                            | 说明                                                                            |
| ------------------- | ---- | --------------------------------- | ------------------------------------------------------------------------------- |
| `anthropic-api-key` | ✅   | —                                 | Anthropic API 密钥。                                                            |
| `github-token`      |      | `${{ github.token }}`             | 用于读取 PR 和写入报告评论的 token。                                            |
| `model`             |      | `claude-opus-5-5`                 | Claude 模型 ID。                                                                |
| `effort`            |      | `high`                            | 推理深度:`low`、`medium`、`high`、`xhigh`、`max`。                              |
| `language`          |      | `en`                              | 输出语言:`en`、`ko`、`ja`、`zh-CN`(别名 `kr`、`jp`、`cn`、`zh`)。               |
| `trigger-label`     |      | `needs-ai-qa`                     | 请求运行的标签。                                                                |
| `rerun-on-push`     |      | `true`                            | 标签保留期间,有新提交时重新运行。                                               |
| `require-prd`       |      | `false`                           | 一个关联 PRD 都获取不到时判为失败。                                             |
| `token-budget`      |      | `150000`                          | 每次 LLM 调用的输入 token 预算(估算);超出的 PR 用 Map-Reduce 拆分。             |
| `max-cost-usd`      |      | `2.00`                            | 单次运行的估算成本上限(美元);超出时从优先级低的文件开始排除。                   |
| `max-scenarios`     |      | `20`                              | 报告中的最大场景数。                                                            |
| `comment-author`    |      | —                                 | 写报告评论的 login;仅在使用自定义 GitHub App token 时指定(例如 `my-app[bot]`)。 |
| `pr-comment`        |      | `true`                            | 以 PR 评论发布报告(原地更新同一条评论)。                                        |
| `slack-bot-token`   |      | —                                 | Slack Bot token(`xoxb-`)。设置后启用 Bot 模式(更新 + 线程)。                    |
| `slack-channel`     |      | —                                 | Bot 模式的频道 ID 或 `#名称`。                                                  |
| `slack-webhook-url` |      | —                                 | Slack Incoming Webhook URL,没有 Bot token 时使用。                              |
| `jira-base-url`     |      | —                                 | Jira Cloud 站点 URL(例如 `https://acme.atlassian.net`)。                        |
| `jira-email`        |      | —                                 | 用于 API token 认证的 Jira 账号邮箱。                                           |
| `jira-api-token`    |      | —                                 | Jira API token。URL、邮箱和 token 都设置后才启用 Jira。                         |
| `jira-project-keys` |      | —                                 | 在 PR 正文中只写键名也能识别的项目键,逗号分隔(例如 `PROJ,WEB`)。                |
| `notion-token`      |      | —                                 | Notion integration token。                                                      |
| `config-path`       |      | `.github/qa-ticket-generator.yml` | 仓库配置文件,从 base 分支读取。                                                 |
| `fail-on`           |      | `none`                            | PRD 一致性未达标时让检查失败:`none`、`partial`、`misaligned`。                  |
| `fail-on-error`     |      | `false`                           | 内部错误时让检查失败(默认只给出警告)。                                          |
| `allow-fork-prs`    |      | `false`                           | 允许为 fork PR 运行(仅限 `pull_request_target` 的启用工作流)。                  |
| `server-fallback`   |      | `true`                            | 启用 Anthropic 服务端的 refusal 回退。                                          |
| `dry-run`           |      | `false`                           | 不发布,只把报告写入 Job Summary。                                               |
<!-- inputs:end -->

使用 `GITHUB_TOKEN` 或个人访问令牌(PAT)时会自动识别 `comment-author`。

### Outputs

<!-- outputs:start -->
| Output             | 说明                                             |
| ------------------ | ------------------------------------------------ |
| `report-path`      | `report.json` 的路径。                           |
| `scenario-count`   | 生成的场景数量。                                 |
| `alignment-status` | `aligned`、`partial`、`misaligned` 或 `no_prd`。 |
| `cost-usd`         | 本次运行的估算成本(美元)。                       |
| `skipped-reason`   | 若被跳过,给出原因。                              |
<!-- outputs:end -->

## 关联 PRD

在 PR 正文中写上需求文档的链接:

| 来源         | 识别的格式                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| GitHub Issue | `#123`、`owner/repo#123`、`https://github.com/owner/repo/issues/123`、`Closes #123` / `Fixes` / `Resolves` |
| Jira Cloud   | `https://<site>.atlassian.net/browse/KEY-123`,以及 `KEY` 在 `jira-project-keys` 中时的 `KEY-123`           |
| Notion       | `https://www.notion.so/…<32 位 hex ID>`、`https://<workspace>.notion.site/…<32 位 hex ID>`                 |

- 最多使用 5 个文档(可配置),按在正文中出现的顺序,重复的会被忽略。
- HTML 注释和代码块中的链接会被忽略,因此 PR 模板里的示例链接不会被误识别。
  现成的模板:[`examples/pull_request_template.md`](examples/pull_request_template.md)。
- 验收标准从 "Acceptance Criteria"(或 "AC")标题下的列表,或复选框列表中读取;找不到时由 Claude 从文档正文中理解需求。
- 没有关联 PRD 时,会以仅基于代码的模式继续运行,并在报告中标注为低置信度。如需改为失败,请设置 `require-prd: true`。

## 仓库配置文件

可选的 `.github/qa-ticket-generator.yml` 用于调整过滤规则、PRD 设置、评分规则和提示词指令。
该文件始终从 **base** 分支读取,因此 PR 无法修改针对自身的指令。
优先级:action input > 此文件 > 默认值。示例:[`examples/qa-ticket-generator.yml`](examples/qa-ticket-generator.yml)。

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

同一条流水线也可以在本地运行。默认是 dry-run:只打印报告,不发布任何内容。

```bash
export GITHUB_TOKEN=… ANTHROPIC_API_KEY=…
npx qa-ticket-generator run --repo owner/repo --pr 123            # dry run (default)
npx qa-ticket-generator run --repo owner/repo --pr 123 --format json --out report.json
npx qa-ticket-generator run --repo owner/repo --pr 123 --publish  # write the PR comment / Slack message
```

其他设置使用与 action input 同名的大写环境变量(例如 `JIRA_BASE_URL`、`NOTION_TOKEN`、`MAX_SCENARIOS`)。
运行 `npx qa-ticket-generator --help` 查看全部选项。

## 成本

- 每次运行都有估算成本上限 `max-cost-usd`(默认 **$2.00**)。调用 Claude 之前先估算成本,超出上限时从优先级低的文件
  开始排除,并在报告中列出被排除的文件。
- `token-budget` 限制单次 LLM 调用的输入(默认 150,000 token),更大的 PR 会被拆分处理。关联的 PRD
  最多占用该预算的 30%。
- 2026-11-12 使用 Claude Opus 5.5、`effort: high` 对**小型 PR**(10 个合成 PR 和 1 个沙箱 PR,每个 PR 改动 1–3 个文件,
  每次运行调用 LLM 1 次)实测:单次运行约 **$0.09–$0.19,平均 $0.13**,耗时约 50–70 秒。大型 PR 会拆成多次调用,成本可能
  更高;`max-cost-usd`(默认 $2.00)为每次运行设定上限。每次运行的估算成本显示在报告底部。
- 只改动噪声文件的 push 不会调用 Claude。

## 安全与数据流

- **不 checkout。** 从不 checkout 或执行 PR 代码,所有内容都通过 API 读取。
- **默认跳过 fork PR。** 文档中的 `pull_request_target` 启用方式只在维护者添加标签时运行。
- **密钥脱敏。** 在发送给模型之前,对 diff、文件内容、PRD 以及 PR 标题和正文中的密钥进行脱敏,
  并在报告中显示脱敏数量。
  token 在日志中会被屏蔽,日志只记录大小和数量。
- **代码和 PRD 只发送到 Anthropic API。** 没有遥测。
- **配置从 base 分支读取**,模型输出只作为数据处理:转义 HTML,使 Slack 提及失效,链接仅限 PR、PRD 原文和本仓库。
- **受信任的评论作者。** 只信任由 token 身份(`github-actions[bot]` 或 PAT 所有者)写的报告评论。同一仓库中的其他工作流
  如果以 `github-actions[bot]` 身份原样评论 PR 作者的输入,可能伪造隐藏的 state,但影响仅限于 push 时的重新运行判定
  和要更新哪条 Slack 消息。
- 请使用示例中的最小权限:`contents: read`、`pull-requests: write`、`issues: read`。

如发现漏洞,请按 [`SECURITY.md`](../SECURITY.md) 中的说明私下报告。

## 常见问题与限制

- **添加工作流后,给已有 PR 加标签却没有运行?** 在添加工作流文件之前打开的 PR,在 GitHub 更新其合并提交之前看不到
  新的工作流。请用 base 分支更新 PR 分支(**Update branch** 按钮、`gh pr update-branch <number>`,或 merge/rebase
  base 分支后 push);只要标签还在,这次 push 就会触发运行。添加工作流之后新打开的 PR 不受影响。
- **Slack Webhook 模式**每次运行只新发一张摘要卡片。更新之前的消息和在线程中发送详情需要 Bot 模式
  (`slack-bot-token` + `slack-channel`)。
- **其他私有仓库中的 Issue** 无法用默认的 `GITHUB_TOKEN` 读取。请把个人访问令牌(PAT)或 GitHub App token 作为
  `github-token` 传入;在此之前,报告中会显示权限警告。
- **仅支持 Jira Cloud。** v1 不支持 Jira Server 和 Data Center。
- **Notion 页面**必须共享给 integration(页面菜单 → 连接)。
- 目前**仅支持 github.com**,暂不支持 GitHub Enterprise Server。

## 贡献与许可证

欢迎贡献,请参阅 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 和[行为准则](../CODE_OF_CONDUCT.md)。
设计文档:[`SPEC.ko.md`](SPEC.ko.md)(韩语) · [`adr/`](adr/) · [`DEVELOPMENT.md`](DEVELOPMENT.md)。

采用 [Apache-2.0](../LICENSE) 许可证。
