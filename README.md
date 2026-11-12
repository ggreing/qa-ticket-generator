# qa-ticket-generator

**English** | [한국어](docs/README.ko.md) | [日本語](docs/README.ja.md) | [简体中文](docs/README.zh-CN.md)

<!-- Badges (CI, release, license) are added when the repository is published. -->

> 🚧 pre-v0.1. It works on our test repos, but inputs and the comment layout can still change.

A GitHub Action that reads a pull request together with the ticket it is supposed to implement, and writes
the QA notes a tester would: which requirements are covered, which ones are missing, and a short list of
test cases worth running before you merge.

## Why

On small teams there is usually no dedicated QA person, and the reviewer rarely has the Jira ticket open
next to the diff. So a PR gets approved, the tests pass, and a week later someone notices that one of the
acceptance criteria never got built.

This action does that cross-check for you. Put the ticket link in the PR description, add the
`needs-ai-qa` label, and a minute or two later the PR has a comment from Claude that compares the code with
the requirements. It is not a code reviewer and it won't comment on style. It only cares whether the change
does what the spec says, and what you should test to find out.

## What you get

Roughly what the comment looks like (the layout is still being polished for v0.1):

```markdown
## 🧪 AI QA — 4e2455c · ⚠️ Partially aligned

**Needs attention (2)**

- ❌ AC2 Expired coupons are rejected: nothing compares `expiresAt` with the current time (`src/coupon.ts`)
- ❌ AC4 Percent discounts are capped at 10,000 KRW: no cap is applied

**P0 checklist**

- [ ] TC-01 Coupon that expired one second ago → rejected, no usage recorded
- [ ] TC-02 Same user applies the same coupon twice at once → only one succeeds
- [ ] TC-03 10% coupon on a 200,000 KRW order → discount is 10,000, not 20,000

<details><summary>TC-01 Reject an expired coupon [P0 · AC2]</summary>
Setup: user-A has never used EXP1, cart subtotal is 30,000 KRW
Data: code = EXP1, expiresAt = now - 1s
Steps: 1. open checkout 2. apply EXP1
Expected: CouponError "Coupon has expired", no usage record for (user-A, EXP1)
</details>

<details><summary>P1 / P2 cases (9)</summary>…</details>
```

When you push more commits, the same comment is updated instead of a new one being added. Pushes that only
touch lockfiles or build output are ignored. If you connect Slack, a short summary goes to a channel and the
test cases go into its thread.

Here is how a run flows, if you are curious:

![Architecture: GitHub event, trigger gate, context and PRD collection, preprocessing, Claude, then PR comment, Slack and job summary](docs/diagrams/architecture.png)

## Setup

You need an Anthropic API key and about five minutes.

1. Add the key as a repository secret named `ANTHROPIC_API_KEY`.
2. Create a label called `needs-ai-qa`.
3. Add this workflow as `.github/workflows/qa-ticket-generator.yml`:

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
      # No actions/checkout here on purpose: the action reads the PR through the API.
      - uses: ggreing/qa-ticket-generator@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

That's it. Label a PR and wait for the comment. If your specs live in Jira or Notion, or you want Slack
messages, the full example in [`docs/examples/workflow.yml`](docs/examples/workflow.yml) shows the extra
inputs. Output in Korean, Japanese or Chinese is one line: `language: ko` (or `ja`, `zh-CN`).

Fork PRs are skipped by default, because GitHub doesn't give them your secrets. There is an opt-in
workflow in [`docs/examples/workflow-fork-opt-in.yml`](docs/examples/workflow-fork-opt-in.yml); please read
the warning at the top before using it.

## Linking the spec

The action looks for ticket links in the PR description:

- GitHub issues: `#123`, `owner/repo#123`, a full issue URL, or `Closes #123`
- Jira Cloud: `https://your-site.atlassian.net/browse/PROJ-123`, or just `PROJ-123` if you list `PROJ` in
  `jira-project-keys`
- Notion: a `notion.so` or `notion.site` page URL

It reads acceptance criteria from a list under an "Acceptance Criteria" (or "AC") heading, or from a
checklist. If there is no such section it works from the whole ticket body. Links inside code blocks and
HTML comments are ignored, so the examples in a PR template won't be picked up. We ship one you can copy:
[`docs/examples/pull_request_template.md`](docs/examples/pull_request_template.md).

No ticket linked? It still runs, works from the code alone, and says so at the top of the comment. Set
`require-prd: true` if you'd rather have the check fail.

## Running it locally

The same thing runs as a CLI. By default it only prints the report and doesn't post anything:

```bash
export GITHUB_TOKEN=… ANTHROPIC_API_KEY=…
npx qa-ticket-generator run --repo owner/repo --pr 123            # dry run (default)
npx qa-ticket-generator run --repo owner/repo --pr 123 --format json --out report.json
npx qa-ticket-generator run --repo owner/repo --pr 123 --publish  # write the PR comment / Slack message
```

Any action input also works as an upper-case environment variable (`JIRA_BASE_URL`, `MAX_SCENARIOS`, …).
`npx qa-ticket-generator --help` lists the flags.

## What it costs

On the small PRs we have tried so far (one to three changed files), a run with Claude Opus 5.5 costs about
$0.09 to $0.19, $0.13 on average, and takes about a minute. That was measured on 10 synthetic PRs and one
sandbox PR, so treat it as a ballpark.

Bigger PRs are split into several calls and cost more, so every run has a ceiling: `max-cost-usd`, $2 by
default. If a run would go over it, the least important files are left out and the comment lists them. The
estimated cost of each run is printed at the bottom of the comment.

## Where your code goes

The action never checks out or runs the code in the PR. It reads the diff, the changed files and the linked
tickets through the GitHub, Jira and Notion APIs, and sends them to Anthropic's API. Nothing goes anywhere
else, and there is no telemetry.

Before anything is sent, things that look like secrets (API keys, tokens, private keys, passwords in config)
are masked, including in the PR title and description. The comment tells you how many were masked. Logs only
contain counts and sizes, never file contents.

Two more things worth knowing:

- The repository config file is read from the base branch, so a PR can't change the instructions it is
  reviewed with. Text written by the model is escaped before it is posted, Slack mentions are disabled, and
  links are limited to the PR, the linked tickets and your repository.
- Between runs the action keeps a little state in a hidden block of its own comment, and only trusts comments
  written by its own token (`github-actions[bot]` or the owner of the PAT you passed). If another workflow in
  your repository posts PR-author text as `github-actions[bot]`, that state could be faked. The worst outcome
  is a skipped re-run or the wrong Slack message being edited.

Found a security problem? Please report it privately, see [`SECURITY.md`](SECURITY.md).

## Known gaps

- Labeling a PR that was opened _before_ you added the workflow may do nothing. GitHub doesn't refresh that
  PR's merge commit, so it never sees the new workflow. Update the branch (the "Update branch" button or
  `gh pr update-branch <number>`) and the next push starts a run.
- Slack incoming webhooks can only post, so each run adds a new message. For update-in-place and threads,
  use a bot token (`slack-bot-token` and `slack-channel`).
- The default `GITHUB_TOKEN` can't read issues in other private repositories. Pass a personal access token
  or GitHub App token as `github-token` if your specs live elsewhere.
- Jira Cloud only (no Server or Data Center), and github.com only (no GitHub Enterprise Server) for now.
- Notion pages have to be shared with your integration (page menu → Connections).
- The model only sees the changed files. If a requirement is handled in a file the PR doesn't touch, it may
  be reported as missing; the comment lists that kind of assumption at the end.

## Configuration reference

### Inputs

<!-- inputs:start -->
| Input               | Required | Default                           | Description                                                                   |
| ------------------- | -------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `anthropic-api-key` | ✅       | —                                 | Anthropic API key.                                                            |
| `github-token`      |          | `${{ github.token }}`             | Used to read the PR and write the comment.                                    |
| `model`             |          | `claude-opus-5-5`                 | Claude model id.                                                              |
| `effort`            |          | `high`                            | `low`, `medium`, `high`, `xhigh` or `max`. Lower is cheaper and faster.       |
| `language`          |          | `en`                              | `en`, `ko`, `ja` or `zh-CN` (`kr`, `jp`, `cn`, `zh` work too).                |
| `trigger-label`     |          | `needs-ai-qa`                     | The label that starts a run.                                                  |
| `rerun-on-push`     |          | `true`                            | Run again on new commits while the label is on the PR.                        |
| `require-prd`       |          | `false`                           | Fail the check when no linked ticket can be read.                             |
| `token-budget`      |          | `150000`                          | Input tokens per model call. Bigger PRs are split into several calls.         |
| `max-cost-usd`      |          | `2.00`                            | Cost ceiling per run. Less important files are dropped to stay under it.      |
| `max-scenarios`     |          | `8`                               | Maximum number of test cases in the comment.                                  |
| `comment-author`    |          | —                                 | Only needed with a custom GitHub App token, e.g. `my-app[bot]`.               |
| `pr-comment`        |          | `true`                            | Post (and keep updating) the PR comment.                                      |
| `slack-bot-token`   |          | —                                 | Slack bot token (`xoxb-`). Gives you update-in-place and threads.             |
| `slack-channel`     |          | —                                 | Channel id or `#name` for the bot.                                            |
| `slack-webhook-url` |          | —                                 | Incoming webhook, used when there is no bot token.                            |
| `jira-base-url`     |          | —                                 | e.g. `https://acme.atlassian.net`.                                            |
| `jira-email`        |          | —                                 | Jira account email.                                                           |
| `jira-api-token`    |          | —                                 | Jira API token. Jira is used when URL, email and token are all set.           |
| `jira-project-keys` |          | —                                 | Comma-separated keys to recognize bare `KEY-123` references, e.g. `PROJ,WEB`. |
| `notion-token`      |          | —                                 | Notion integration token.                                                     |
| `config-path`       |          | `.github/qa-ticket-generator.yml` | Repository config file, read from the base branch.                            |
| `fail-on`           |          | `none`                            | Fail the check when alignment is `partial` or `misaligned`.                   |
| `fail-on-error`     |          | `false`                           | Fail the check on internal errors. By default they only show as a warning.    |
| `allow-fork-prs`    |          | `false`                           | Allow fork PRs. Only use this with the opt-in workflow.                       |
| `server-fallback`   |          | `true`                            | Let Anthropic retry on another model if Opus declines a request.              |
| `dry-run`           |          | `false`                           | Write the report to the job summary only.                                     |
<!-- inputs:end -->

### Outputs

<!-- outputs:start -->
| Output             | Description                                     |
| ------------------ | ----------------------------------------------- |
| `report-path`      | Path to `report.json` with the full result.     |
| `scenario-count`   | How many test cases were written.               |
| `alignment-status` | `aligned`, `partial`, `misaligned` or `no_prd`. |
| `cost-usd`         | Estimated cost of the run.                      |
| `skipped-reason`   | Why the run was skipped, if it was.             |
<!-- outputs:end -->

### Repository config file

You can put `.github/qa-ticket-generator.yml` in your repository to exclude paths, tell it which Jira field
holds your acceptance criteria, or add a few lines of domain context. Action inputs win over this file. The
full example is in [`docs/examples/qa-ticket-generator.yml`](docs/examples/qa-ticket-generator.yml).

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

Bug reports and PRs are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains how to run the tests (they
never call real APIs). The design notes are in [`docs/SPEC.ko.md`](docs/SPEC.ko.md) (Korean for now) and
[`docs/adr/`](docs/adr/).

Apache-2.0, see [LICENSE](LICENSE).
