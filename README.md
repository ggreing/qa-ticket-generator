# qa-ticket-generator

**English** | [한국어](docs/README.ko.md) | [日本語](docs/README.ja.md) | [简体中文](docs/README.zh-CN.md)

<!-- Badges (CI, release, license) are added when the repository is published. -->

> 🚧 **Under active development (pre-v0.1). Not ready for use yet.** Inputs and output may still change.
>
> This README describes the behavior planned for v0.1. Implemented so far: the trigger gate, PRD collection
> (GitHub Issues, Jira Cloud, Notion), report generation with the cost guard, PR comment / Slack / job-summary
> delivery and the CLI. Still in progress: diff preprocessing (noise filter, function-level context, secret
> redaction, token packing) — features that depend on it are marked _(in progress)_.

A GitHub Action that cross-checks a pull request's code changes against its linked product requirements
(GitHub Issues, Jira Cloud, Notion) with Claude, then publishes BDD (Given / When / Then) QA scenarios and a
PRD-alignment report to the PR and Slack.

## How it works

![Architecture: GitHub event → trigger gate → context and PRD collection → preprocessing → Claude → PR comment, Slack and job summary](docs/diagrams/architecture.png)

1. **Trigger.** Adding the `needs-ai-qa` label to a PR starts a run; new pushes re-run it while the label stays
   (configurable). Pushes that only touch noise files (lockfiles, build output, snapshots …) are skipped
   _(in progress)_.
2. **Collect and prepare.** The action reads the diff and the linked PRDs through the GitHub, Jira and Notion
   APIs — it never checks out your code. It drops noise files, expands changes to the enclosing
   function or class, redacts secrets and packs the most relevant files into the token budget _(in progress)_.
3. **Generate and publish.** Claude compares the code with the acceptance criteria and returns happy-path,
   edge-case and negative scenarios plus missing or contradicting requirements. The report is posted as
   one PR comment that is updated on every run, optionally sent to Slack, and always written to the job summary.

## Example output

An illustrative mock-up of the PR comment (the real layout may change before v0.1):

```markdown
## 🧪 AI QA Scenarios — `a1b2c3d` · ⚠️ PRD alignment: **Partial**

> Linked: PROJ-123 (Jira), #45 (GitHub)

### PRD Alignment

| Requirement                       | Status     | Evidence                                 |
| --------------------------------- | ---------- | ---------------------------------------- |
| AC1: a coupon applies once        | ✅ covered | `CouponService.apply()` checks prior use |
| AC3: expired coupons are rejected | ❌ missing | no expiry comparison in `coupon.ts`      |

### Scenarios (12)

<details><summary><b>[P0][Edge] Apply a coupon one second before it expires</b></summary>

- **Given** a coupon that expires one second from now
- **When** the shopper applies it at checkout
- **Then** the discount is applied
- _Related_: AC3 · `src/coupon/coupon.ts`
</details>

### Risks

- …

<sub>model · input / output tokens · estimated cost · duration · skipped files</sub>
```

In Slack bot mode a summary card (alignment badge, scenario counts, top risks, links to the PR and the
full report) is posted, with the scenario details in its thread.

## Quickstart

1. Add an `ANTHROPIC_API_KEY` repository secret. Optional: `SLACK_BOT_TOKEN`, `JIRA_API_TOKEN`, `NOTION_TOKEN`.
2. Create the `needs-ai-qa` label in the repository.
3. Copy [`docs/examples/workflow.yml`](docs/examples/workflow.yml) to `.github/workflows/qa-ticket-generator.yml`
   and delete the Slack, Jira or Notion inputs you don't use.

Then add the label to a pull request. Do **not** add `actions/checkout` — the action reads everything through
the API. Fork PRs are skipped by default; see [`docs/examples/workflow-fork-opt-in.yml`](docs/examples/workflow-fork-opt-in.yml)
for the opt-in and its warnings.

## Inputs and outputs

### Inputs

<!-- inputs:start -->
| Input               | Required | Default                           | Description                                                                                   |
| ------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `anthropic-api-key` | ✅       | —                                 | Anthropic API key.                                                                            |
| `github-token`      |          | `${{ github.token }}`             | Token for reading the PR and writing the report comment.                                      |
| `model`             |          | `claude-opus-5-5`                 | Claude model id.                                                                              |
| `effort`            |          | `high`                            | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`.                                    |
| `language`          |          | `en`                              | Output language: `en`, `ko`, `ja`, `zh-CN` (aliases `kr`, `jp`, `cn`, `zh`).                  |
| `trigger-label`     |          | `needs-ai-qa`                     | Label that requests a QA run.                                                                 |
| `rerun-on-push`     |          | `true`                            | Re-run on new commits while the label is present.                                             |
| `require-prd`       |          | `false`                           | Fail when no linked PRD can be fetched.                                                       |
| `token-budget`      |          | `150000`                          | Estimated input-token budget per LLM call; larger PRs are split (map-reduce).                 |
| `max-cost-usd`      |          | `2.00`                            | Estimated cost ceiling per run in USD; lowest-priority files are dropped beyond it.           |
| `max-scenarios`     |          | `20`                              | Maximum number of scenarios in the report.                                                    |
| `comment-author`    |          | —                                 | Login that writes the report comment; only for custom GitHub App tokens (e.g. `my-app[bot]`). |
| `pr-comment`        |          | `true`                            | Publish the report as a PR comment (updated in place).                                        |
| `slack-bot-token`   |          | —                                 | Slack bot token (`xoxb-`). Enables bot mode (update + thread).                                |
| `slack-channel`     |          | —                                 | Channel id or `#name` for bot mode.                                                           |
| `slack-webhook-url` |          | —                                 | Slack incoming webhook URL, used when no bot token is set.                                    |
| `jira-base-url`     |          | —                                 | Jira Cloud site URL, e.g. `https://acme.atlassian.net`.                                       |
| `jira-email`        |          | —                                 | Jira account email for API-token auth.                                                        |
| `jira-api-token`    |          | —                                 | Jira API token. Jira is enabled when the URL, email and token are all set.                    |
| `jira-project-keys` |          | —                                 | Comma-separated project keys recognized as bare keys in PR bodies (e.g. `PROJ,WEB`).          |
| `notion-token`      |          | —                                 | Notion integration token.                                                                     |
| `config-path`       |          | `.github/qa-ticket-generator.yml` | Repository config file, read from the base branch.                                            |
| `fail-on`           |          | `none`                            | Fail the check on PRD alignment: `none`, `partial`, `misaligned`.                             |
| `fail-on-error`     |          | `false`                           | Fail the check on internal errors (by default they only warn).                                |
| `allow-fork-prs`    |          | `false`                           | Allow runs for fork PRs (only with the `pull_request_target` opt-in workflow).                |
| `server-fallback`   |          | `true`                            | Enable Anthropic's server-side refusal fallback.                                              |
| `dry-run`           |          | `false`                           | Do not publish; write the report to the job summary only.                                     |
<!-- inputs:end -->

`comment-author` is detected automatically for `GITHUB_TOKEN` and personal access tokens.

### Outputs

<!-- outputs:start -->
| Output             | Description                                     |
| ------------------ | ----------------------------------------------- |
| `report-path`      | Path to `report.json`.                          |
| `scenario-count`   | Number of generated scenarios.                  |
| `alignment-status` | `aligned`, `partial`, `misaligned` or `no_prd`. |
| `cost-usd`         | Estimated cost of this run in USD.              |
| `skipped-reason`   | Why the run was skipped, if it was.             |
<!-- outputs:end -->

## Linking PRDs

Put links to the requirement documents in the PR body:

| Source       | Recognized patterns                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| GitHub Issue | `#123`, `owner/repo#123`, `https://github.com/owner/repo/issues/123`, `Closes #123` / `Fixes` / `Resolves` |
| Jira Cloud   | `https://<site>.atlassian.net/browse/KEY-123`, and bare `KEY-123` when `KEY` is in `jira-project-keys`     |
| Notion       | `https://www.notion.so/…<32-hex id>`, `https://<workspace>.notion.site/…<32-hex id>`                       |

- Up to 5 documents (configurable) are used, in the order they appear. Duplicates are ignored.
- Links inside HTML comments and code blocks are ignored, so PR-template examples are safe.
  A ready-made template: [`docs/examples/pull_request_template.md`](docs/examples/pull_request_template.md).
- Acceptance criteria are read from lists under an "Acceptance Criteria" (or "AC") heading, or from checkbox
  lists. Without them, Claude infers the requirements from the document body.
- Without any linked PRD the run continues in code-only mode and the report is marked as low confidence.
  Set `require-prd: true` to fail instead.

## Repository config

An optional `.github/qa-ticket-generator.yml` tunes filters, PRD settings, scoring and prompt instructions.
It is always read from the **base** branch, so a pull request cannot change its own instructions.
Precedence: action input > this file > defaults. Example:
[`docs/examples/qa-ticket-generator.yml`](docs/examples/qa-ticket-generator.yml).

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

The same pipeline runs locally. It is a dry run by default: the report is printed and nothing is published.

```bash
export GITHUB_TOKEN=… ANTHROPIC_API_KEY=…
npx qa-ticket-generator run --repo owner/repo --pr 123            # dry run (default)
npx qa-ticket-generator run --repo owner/repo --pr 123 --format json --out report.json
npx qa-ticket-generator run --repo owner/repo --pr 123 --publish  # write the PR comment / Slack message
```

Optional settings use the same names as the action inputs, as upper-case environment variables
(e.g. `JIRA_BASE_URL`, `NOTION_TOKEN`, `MAX_SCENARIOS`). Run `npx qa-ticket-generator --help` for all flags.

## Cost

- Every run has an estimated cost ceiling, `max-cost-usd` (default **$2.00**). The action estimates the cost
  before calling Claude and drops the lowest-priority files when the estimate is over the ceiling; the
  report lists what was dropped.
- `token-budget` caps the input of a single LLM call (default 150,000 tokens); larger PRs are split.
- For a typical PR with Claude Opus 5.5 at `effort: high`, a run is **estimated** at roughly $0.15–$0.40.
  This is a design estimate, not a measurement; the report footer shows the estimate for each run.
- Pushes that only change noise files do not call Claude at all _(in progress)_.

## Security and data flow

- **No checkout.** The action never checks out or executes pull-request code; it reads everything through APIs.
- **Fork PRs are skipped by default.** The documented `pull_request_target` opt-in runs only when a maintainer
  adds the label.
- **Secrets are redacted** from diffs, file contents and PRDs before anything reaches the model, and the number
  of redactions is shown in the report _(in progress)_. Tokens are masked in logs; logs contain sizes and
  counts only.
- **Code and PRD content go only to the Anthropic API.** No telemetry.
- **Config from the base branch** and model output treated as data: HTML is escaped, Slack mentions are
  neutralized and links are restricted to the PR, the PRD sources and the repository.
- **Trusted comment author.** Only report comments written by the token's identity (`github-actions[bot]` or the
  PAT owner) are trusted. Another workflow in the same repository that posts PR-author input verbatim as
  `github-actions[bot]` could forge the hidden state, but the impact is limited to the re-run decision on push
  and to which Slack message is updated.
- Use the minimal permissions from the examples: `contents: read`, `pull-requests: write`, `issues: read`.

Please report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## FAQ and limitations

- **Slack webhook mode** posts one new summary card per run. Updating the previous message and threaded
  details need bot mode (`slack-bot-token` + `slack-channel`).
- **Issues in other private repositories** cannot be read with the default `GITHUB_TOKEN`. Pass a personal access
  token or a GitHub App token as `github-token`; until then the report shows a permission warning.
- **Jira Cloud only.** Jira Server and Data Center are not supported in v1.
- **Notion pages** must be shared with the integration (page menu → Connections).
- **github.com only** for now; GitHub Enterprise Server is not supported yet.

## Contributing and license

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Design documents: [`docs/SPEC.ko.md`](docs/SPEC.ko.md) (Korean) · [`docs/adr/`](docs/adr/) ·
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

Licensed under [Apache-2.0](LICENSE).
