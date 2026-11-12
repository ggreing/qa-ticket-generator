# qa-ticket-generator

> 🚧 Under active development (pre-v0.1). Not ready for use yet.

A GitHub Action that cross-checks a pull request's code changes against its linked product requirements
(GitHub Issues, Jira, Notion) using Claude, then publishes BDD (Given / When / Then) QA scenarios and a
PRD-alignment report to the PR and Slack.

- Label a PR with `needs-ai-qa` → get happy-path, edge-case and negative scenarios in about two minutes.
- Missing or contradicting acceptance criteria are flagged before merge.
- Serverless: one workflow file and one API key. No checkout of PR code, no telemetry.

Design docs: [`docs/SPEC.ko.md`](docs/SPEC.ko.md) (Korean, English translation planned) · [`docs/adr/`](docs/adr/) · [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)

License: [Apache-2.0](LICENSE)
