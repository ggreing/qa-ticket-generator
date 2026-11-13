# qa-ticket-generator

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

<!-- 徽章(CI、发布、许可证)会在仓库公开时加上。 -->

> 🚧 pre-v0.1。在我们的测试仓库里已经能用了,但 input 名称和评论的样子可能还会变。

一个 GitHub Action:读需求文档(GitHub issue、Jira 故事或 Notion 页面),写出测试同学会跑的测试用例,每条
用例一张单子,容易漏掉的也算在内。等实现这份需求的 PR 提上来,它再把代码和这些用例对一遍,告诉你哪些看起来
已经实现了。

## Why

小团队一般没有专职 QA,评审的人看 diff 的时候也很少会把 Jira 单子开在旁边。于是 PR 评审通过了,测试也全绿,
过了一周才有人发现有一条验收标准压根没做。

这个 Action 帮你做 QA 的准备工作。在写代码之前,它先读需求,把每条验收标准变成具体的测试用例,边界值和失败
场景也包括在内。之后 PR 提上来,它再逐条拿用例和代码对照。它不是代码审查机器人,不管代码风格,只关心这次
改动是不是按需求做了,以及要验证这一点该测什么。

## How it works

1. 规划。给需求 issue 打上 `needs-qa-plan` 标签,或者填上 Jira key 或 Notion 链接手动运行 workflow。
   Claude 会对每条验收标准套用常见的测试方法(边界值、非法输入、权限、并发、时区等)来写用例,需求里没写到
   的地方也会写成用例。
2. 用例单。每条用例都会在团队平时用的地方生成一张单子:GitHub issue、故事下面的 Jira 子任务,或者 Notion
   数据库里的一行,三者任选。同时还会输出 `qa-cases.md`、`.csv` 和 `.json` 文件,CSV 可以导入 TestRail
   或表格。需求上会留一条列出所有用例的评论。
3. 对照 PR。给关联了需求的 PR 打上 `needs-ai-qa`。每条用例都会得到一个代码状态(已实现、疑似未实现、与需求
   矛盾、从代码看不出来),只在 diff 里才看得出的风险会变成新的用例,PR 上会留一条带 P0 检查清单的摘要评论。
   如果这份需求还没生成过用例,这一步会先生成。

重复运行没有问题。同一条用例的 ID 和单子都不会变,所以不会重复。团队填写的执行结果、负责人、评论和标签都不会
被覆盖。如果有人改过单子的内容,它会保持原样,把本来要改的内容作为评论留下。需求里去掉的用例不会被关闭或
删除,只会标记为不再适用。

之后的运行只做需要做的事。如果需求自上次规划以来没有变化,就不会重新生成用例(仍想重新生成的话设
`force-plan: true`)。对照 PR 时,已经对照过的提交,以及只改了注释或空白的 push 都会跳过。第一次对照之后,
新用例只来自改动的行;一条用例只有在它依据的文件改了,或者它还在等代码时,才会重新判断。手动运行
workflow 会从头全部重看。

用 Jira 或 Notion 需要多做一点设置:
[`setup/jira-subtasks.md`](setup/jira-subtasks.md)、
[`setup/notion-qa-database.md`](setup/notion-qa-database.md)。

## What you get

它写出来的一张用例单大概长这样(标题是 `[P0][边界值] 过期1秒的优惠券应用时被拒绝`):

```markdown
### 前置条件

- 已发放优惠券 EXP1,到期 2026-11-13 23:59:59
- 购物车小计 30,000 韩元

### 测试数据

- 优惠码 EXP1
- 当前时间 2026-11-14 00:00:00

### 步骤

1. 进入结算页面
2. 输入 EXP1 并应用

### 预期结果

- **显示"优惠券已过期"提示**
- 支付金额保持 30,000 韩元

### 容易遗漏的原因

需求中没有定义到期那一秒是否仍有效(小于等于/小于)

### 相关AC

AC3
```

PR 上的评论先说这次改动和需求对得上多少,再列出代码可能漏掉或与需求矛盾的用例,以及 P0 检查清单,每条都
链接到对应的单子。之后再 push 新提交时,它会修改同一条评论,而不是再发一条新的;只改了 lock 文件或构建产物
的 push 会被忽略。

想让检查失败的话,看 `fail-on`。如果某条需求的基本行为已经实现,但部分用例疑似未实现或与需求矛盾,这条需求
算部分满足,徽章显示部分符合。所以 `fail-on: misaligned` 只在基本行为和需求相反时才失败。如果边界用例也要
拦住合并,用 `fail-on: partial`。

没有关联需求的 PR 也会收到评论。这时它会从代码推断需求,写一份简短的测试用例清单,并注明没有可以对照的需求。
如果接上 Slack,频道里会收到这条评论的简短摘要,测试用例放在它的回复串里。

想了解内部流程可以看这张图。

![架构图:GitHub 事件、触发判断、收集上下文和 PRD、预处理、Claude、PR 评论 / Slack / Job Summary](diagrams/architecture.png)

## Setup

只需要一个 Anthropic API key,大概五分钟。

1. 在仓库 secret 里添加名为 `ANTHROPIC_API_KEY` 的 key。
2. 创建两个标签:需求用的 `needs-qa-plan` 和 PR 用的 `needs-ai-qa`。
3. 把下面的 workflow 保存为 `.github/workflows/qa-cases.yml`。

```yaml
name: QA cases
on:
  issues:
    types: [labeled]
  pull_request:
    types: [labeled, synchronize, opened, reopened]
  workflow_dispatch:
    inputs:
      spec: { description: "Issue number, Jira key or Notion URL", required: false }

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  qa:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'issues' && github.event.label.name == 'needs-qa-plan') ||
      (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'needs-ai-qa'))
    concurrency:
      group: qa-cases-${{ github.event.issue.number || github.event.pull_request.number || inputs.spec }}
      cancel-in-progress: ${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    steps:
      # 这里故意不加 actions/checkout,所有内容都通过 API 读取。
      - id: qa
        uses: ggreing/qa-ticket-generator@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      - if: steps.qa.outputs.cases-dir != ''
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: qa-cases
          path: ${{ steps.qa.outputs.cases-dir }}
```

就这些。给需求 issue 打上标签,用例 issue 就会生成;之后再给实现这份需求的 PR 打上标签就行。Jira 和 Notion
的 input 带注释写在 [`examples/workflow-v3.yml`](examples/workflow-v3.yml) 里。如果不需要用例单,只想要 PR
评论,用 [`examples/workflow.yml`](examples/workflow.yml)。想要中文输出的话,加一行 `language: zh-CN` 就可以。

来自 fork 的 PR 默认会跳过,因为 GitHub 不会把 secret 交给 fork 的 PR。确实需要的话可以用
[`examples/workflow-fork-opt-in.yml`](examples/workflow-fork-opt-in.yml),但请先读完文件开头的警告。

## Linking the spec

规划时,需求就是你打了标签的 issue,或者手动运行时填的 `spec`。对照 PR 时,Action 会在 PR 描述里找需求链接:

- GitHub issue:`#123`、`owner/repo#123`、issue 链接、`Closes #123`
- Jira Cloud:`https://your-site.atlassian.net/browse/PROJ-123`;如果在 `jira-project-keys` 里写了
  `PROJ`,只写 `PROJ-123` 也能识别
- Notion:`notion.so` 或 `notion.site` 的页面链接

验收标准从 "Acceptance Criteria"(或 "AC")标题下的列表,或者复选框列表里读取。没有这样的部分时,就根据整个
需求单正文来判断。代码块和 HTML 注释里的链接会被忽略,所以在 PR 模板里放示例链接也没关系。我们也准备了一个
可以直接用的模板:[`examples/pull_request_template.md`](examples/pull_request_template.md)。

没有关联需求单?它照样会运行,只看代码,并在评论开头说明这一点。如果你宁愿让检查直接失败,用
`require-prd: true`。

## Running it locally

同样的功能也可以当 CLI 用。默认不会发到任何地方:`plan` 只写 `qa-cases` 文件,`run` 只打印报告。

```bash
export GITHUB_TOKEN=… ANTHROPIC_API_KEY=…
npx qa-ticket-generator plan --repo owner/repo --spec PROJ-123                                # 只写文件
npx qa-ticket-generator plan --repo owner/repo --spec 42 --sinks github-issue --publish       # 创建用例单
npx qa-ticket-generator run --repo owner/repo --pr 123            # 试运行(默认)
npx qa-ticket-generator run --repo owner/repo --pr 123 --format json --out report.json
npx qa-ticket-generator run --repo owner/repo --pr 123 --publish  # 发布 PR 评论 / Slack 消息
```

所有 Action input 也都可以用大写环境变量传入(`JIRA_BASE_URL`、`MAX_SCENARIOS` 等)。
`npx qa-ticket-generator --help` 可以查看全部参数。

## What it costs

在我们目前试过的小 PR(改动 1 到 3 个文件)上,用 Claude Opus 5.5 跑一次大约 $0.09 到 $0.19,平均 $0.13,
耗时一分钟左右。这是用 10 个合成 PR 和 1 个沙盒 PR 测出来的,只能当个大致参考。

大的 PR 会拆成几次调用,所以会更贵。因此每次运行都有上限:`max-cost-usd`,默认 $2。估计会超出时,会先去掉
不太重要的文件,并在评论里列出去掉了哪些。每次运行的预估费用写在评论最底部。

从需求生成用例的工作量更大,因为要把验收标准分成几批分别写用例,最后再合并。我们估计一份需求大约 $0.5 到
$2,但还没有实际测过。同样受 `max-cost-usd` 上限约束,`max-cases`(默认 80)还会限制一份需求最多产生多少条
用例,超出时先去掉 P2。

## Where your code goes

这个 Action 不会 checkout 或运行 PR 里的代码。它通过 GitHub、Jira、Notion 的 API 读取 diff、改动的文件和
关联的需求单,然后发给 Anthropic 的 API。不会发到别的地方,也没有遥测。

发送之前,看起来像密钥的东西(API key、token、私钥、配置里的密码)都会被遮盖,PR 标题和描述也一样。遮盖了
几处会写在评论里。日志里只有数量和大小,不会有文件内容。

还有两点值得知道:

- 仓库配置文件从 base 分支读取,所以 PR 没法改写用来审查它自己的指令。模型写的文字会先转义再发布,Slack 的
  @ 提及会被禁用,链接只允许指向 PR、关联的需求单和你的仓库。
- 两次运行之间的状态保存在它自己评论的隐藏区块里,而且只信任由自己的 token(`github-actions[bot]`,或你传入的
  PAT 的所有者)写的评论。如果同一仓库里另一个 workflow 会以 `github-actions[bot]` 的身份原样转发 PR 作者写的
  内容,这个状态就有可能被伪造。最坏的结果是某次重新运行被跳过,或者改错了一条 Slack 消息。

发现安全问题请私下告诉我们,不要开公开 issue,详见 [`SECURITY.md`](../SECURITY.md)。

## Known gaps

- npm 包还没有发布,上面的 `npx` 命令在发布前无法使用。Action 现在就能用。需要 CLI 的话,先克隆仓库,
  再运行 `npm ci && npm run build && node dist/cli.js`。
- 在你添加 workflow *之前*就已经打开的 PR,打上标签可能没有任何反应。因为 GitHub 不会刷新那个 PR 的 merge
  提交,它看不到新的 workflow。更新一下分支("Update branch" 按钮或 `gh pr update-branch <number>`),
  之后的 push 就会触发运行。
- 目前只有没关联需求的 PR 会发到 Slack。规划和对照用例单的结果还不会发到 Slack。
- Slack 的 incoming webhook 只能发消息,所以每次运行都会多一条新消息。想要原地更新和回复串,请用 bot token
  (`slack-bot-token` 和 `slack-channel`)。
- 默认的 `GITHUB_TOKEN` 读不了其他私有仓库里的 issue。如果需求写在别的仓库,请把 PAT 或 GitHub App 的 token
  传给 `github-token`。
- 目前 Jira 只支持 Cloud(不支持 Server 和 Data Center),GitHub 只支持 github.com(不支持 GHES)。
- Notion 页面需要先分享给你的 integration(页面菜单 → 连接)。
- Jira 子任务需要挂在一个 Jira 故事下面。如果需求是 GitHub issue 或 Notion 页面,就会跳过 Jira,并在运行日志
  里说明。
- Notion 里会有用例的行,但没有按需求列出的用例清单,因为所有需求的用例都放在同一个数据库里。这份清单会留在
  需求所在的 GitHub issue 或 Jira 故事上。
- 模型只看得到改动过的文件。如果某条需求是在 PR 没碰过的文件里处理的,可能会被判成"缺失";这类假设会集中
  写在评论最后。
- 目前调用 GitHub REST API 时还没带版本头,所以 GitHub 按 2022-11-28 版本响应,并把 issue 相关接口标为
  deprecated。这个版本能用到 2028 年 3 月,我们计划在那之前切到 2026-03-10。
- 代码状态是模型的判断。手动运行会全部重看,其中几条可能会变。
- Jira sink 用到的 issue property(`qtg.case`)还没在真实的 Jira 站点上验证过。
- Notion sink 还没在真实的 Notion workspace 里验证过。

## Configuration reference

### Inputs

<!-- inputs:start -->
| Input                   | 必填 | 默认值                            | 说明                                                                               |
| ----------------------- | ---- | --------------------------------- | ---------------------------------------------------------------------------------- |
| `anthropic-api-key`     | ✅   | —                                 | Anthropic API key。                                                                |
| `github-token`          |      | `${{ github.token }}`             | 用于读取 PR 和写评论。                                                             |
| `model`                 |      | `claude-opus-5-5`                 | Claude 模型 ID。                                                                   |
| `effort`                |      | `high`                            | `low`、`medium`、`high`、`xhigh`、`max`。越低越便宜越快。                          |
| `language`              |      | `en`                              | `en`、`ko`、`ja`、`zh-CN`(`kr`、`jp`、`cn`、`zh` 也行)。                           |
| `trigger-label`         |      | `needs-ai-qa`                     | 触发运行的标签。                                                                   |
| `rerun-on-push`         |      | `true`                            | 标签还在时,每次新提交都重新运行。                                                  |
| `require-prd`           |      | `false`                           | 读不到关联需求单时让检查失败。                                                     |
| `token-budget`          |      | `150000`                          | 单次模型调用的输入 token。大的 PR 会拆成多次调用。                                 |
| `max-cost-usd`          |      | `2.00`                            | 每次运行的费用上限。超出时先去掉不太重要的文件。                                   |
| `max-scenarios`         |      | `8`                               | 评论里测试用例的最大数量。                                                         |
| `comment-author`        |      | —                                 | 只有用自定义 GitHub App token 时才需要,例如 `my-app[bot]`。                        |
| `pr-comment`            |      | `true`                            | 发布 PR 评论并持续更新。                                                           |
| `slack-bot-token`       |      | —                                 | Slack bot token(`xoxb-`),可以原地更新消息和使用回复串。                            |
| `slack-channel`         |      | —                                 | bot 发消息的频道 ID 或 `#名称`。                                                   |
| `slack-webhook-url`     |      | —                                 | 没有 bot token 时使用的 incoming webhook。                                         |
| `jira-base-url`         |      | —                                 | 例如 `https://acme.atlassian.net`。                                                |
| `jira-email`            |      | —                                 | Jira 账号邮箱。                                                                    |
| `jira-api-token`        |      | —                                 | Jira API token。URL、邮箱和 token 都填了才会用 Jira。                              |
| `jira-project-keys`     |      | —                                 | 用逗号分隔,写了的项目只写 `KEY-123` 也能识别,例如 `PROJ,WEB`。                     |
| `notion-token`          |      | —                                 | Notion integration token。                                                         |
| `config-path`           |      | `.github/qa-ticket-generator.yml` | 仓库配置文件,从 base 分支读取。                                                    |
| `fail-on`               |      | `none`                            | 符合度为 `partial` 或 `misaligned` 时让检查失败。                                  |
| `fail-on-error`         |      | `false`                           | 内部错误时让检查失败。默认只给出警告。                                             |
| `allow-fork-prs`        |      | `false`                           | 允许 fork 的 PR。只在 opt-in workflow 里使用。                                     |
| `server-fallback`       |      | `true`                            | Opus 拒绝请求时,由 Anthropic 换一个模型重试。                                      |
| `mode`                  |      | `auto`                            | `auto` 根据事件判断,`plan` 从需求生成 QA 用例,`verify` 对照 PR。                   |
| `spec`                  |      | —                                 | 手动运行时的需求:issue 编号、Jira key 或 Notion 链接。                             |
| `plan-label`            |      | `needs-qa-plan`                   | 启动计划阶段的 issue 标签。                                                        |
| `sinks`                 |      | `github-issue,file`               | 用例工单写到哪里:`jira`、`github-issue`、`notion`、`file`。                        |
| `notion-qa-database-id` |      | —                                 | 存放 QA 用例的 Notion 数据库。                                                     |
| `jira-subtask-type`     |      | `Sub-task`                        | 用例子任务使用的 Jira 问题类型。                                                   |
| `force-plan`            |      | `false`                           | 即使需求未变也重新生成。                                                           |
| `max-cases`             |      | `80`                              | 每个需求的安全上限,超出时先去掉 P2。                                               |
| `previous-cases`        |      | —                                 | 上次运行的 `qa-cases.json` 路径(例如下载的 artifact),file sink 沿用其中的用例 ID。 |
| `dry-run`               |      | `false`                           | 只把报告写到 Job Summary。                                                         |
<!-- inputs:end -->

### Outputs

<!-- outputs:start -->
| Output             | 说明                                             |
| ------------------ | ------------------------------------------------ |
| `report-path`      | 完整结果 `report.json` 的路径。                  |
| `case-count`       | 计划阶段后有效的 QA 用例数。                     |
| `cases-dir`        | 计划阶段后存放 qa-cases.md、.csv、.json 的目录。 |
| `scenario-count`   | 写出的测试用例数量。                             |
| `alignment-status` | `aligned`、`partial`、`misaligned` 或 `no_prd`。 |
| `cost-usd`         | 本次运行的预估费用。                             |
| `skipped-reason`   | 如果跳过了,原因是什么。                          |
<!-- outputs:end -->

### Repository config file

在仓库里放一个 `.github/qa-ticket-generator.yml`,可以设置要排除的路径、验收标准所在的 Jira 字段,或者补充几行
业务背景。Action 的 input 优先于这个文件。完整示例见
[`examples/qa-ticket-generator.yml`](examples/qa-ticket-generator.yml)。

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

欢迎提 bug 和 PR。怎么跑测试写在 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 里(测试不会调用真实 API)。设计文档在
[`SPEC.ko.md`](SPEC.ko.md)(目前只有韩文)和 [`adr/`](adr/)。

许可证是 Apache-2.0,见 [LICENSE](../LICENSE)。
