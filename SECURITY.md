# Security Policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub Security Advisories:
open the repository's **Security** tab and choose **Report a vulnerability**
(<https://github.com/ggreing/qa-ticket-generator/security/advisories/new>).

Do not open a public issue, pull request or discussion for a suspected vulnerability.

Helpful details:

- the affected version or commit SHA, and the workflow configuration (with secrets removed);
- steps to reproduce, and what an attacker could achieve;
- any suggested fix or mitigation.

We will acknowledge the report, keep you informed while we investigate, and credit you in the advisory
unless you prefer to stay anonymous. Please give us reasonable time to release a fix before disclosing
the issue publicly.

## Supported versions

The project is pre-1.0. Security fixes are released for the **latest `v0.x` release only**; please
upgrade before reporting.

| Version        | Supported |
| -------------- | --------- |
| latest `v0.x`  | ✅        |
| older releases | ❌        |

## Data flow

What the action does with your data:

- **Reads** the pull request (metadata, diff, and contents of changed source files) and the linked PRD
  documents (GitHub Issues, Jira, Notion) through their APIs, using only the tokens you provide.
- **Sends** code and PRD content **only to the Anthropic API**, after redacting common secret formats.
  The number of redactions is shown in the report.
- **Publishes** the generated report to the PR comment, the job summary and, if configured, Slack.
- **Never** checks out or executes pull-request code, and never sends telemetry.
- Reads its repository config from the **base** branch, so a pull request cannot change its own
  filters or prompt instructions.
- Registers every token with the runner's log masking and never logs code or PRD text.

## Scope

In scope, for example:

- leaking a secret (API key, token, redacted value) to logs, comments, Slack or the model;
- a way for an outside contributor to run the action with secrets or to trigger paid runs, using the
  documented workflows;
- prompt-injection paths that make the published output unsafe (e.g. bypassing link allow-listing or
  mention neutralization).

Out of scope:

- the quality or correctness of generated QA scenarios;
- configurations that ignore the documentation, such as adding `actions/checkout` to a
  `pull_request_target` workflow;
- vulnerabilities in GitHub, Anthropic, Slack, Jira or Notion themselves (report those to the vendor).

## Hardening recommendations

- Prefer the default `pull_request` workflow ([`docs/examples/workflow.yml`](docs/examples/workflow.yml)).
  Use the fork opt-in ([`docs/examples/workflow-fork-opt-in.yml`](docs/examples/workflow-fork-opt-in.yml))
  only if you need it, and never add a checkout step to it.
- Grant the minimal workflow permissions shown in the examples.
- Pin the action to a full commit SHA rather than a moving tag.
