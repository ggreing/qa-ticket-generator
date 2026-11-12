# ADR-0006: Label trigger with re-run on push

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: Extends v1 ADR-001.
- Spec: `docs/SPEC.ko.md`

## Context

`types: [labeled]` alone ignores commits pushed after labelling; running on every PR wastes tokens.

## Decision

Run when the `needs-ai-qa` label is added, and on `synchronize` while the label is present (`rerun-on-push`, default true). Workflow `concurrency` cancels in-flight runs. A push that only changed noise files since the last analyzed SHA skips the LLM entirely.

## Consequences

- Scenarios track the latest code; cost stays proportional to meaningful changes.

* Frequent pushes on labelled PRs still cost per push.
