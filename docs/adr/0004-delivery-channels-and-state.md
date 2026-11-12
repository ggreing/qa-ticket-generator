# ADR-0004: Updatable PR comment + Slack bot, state stored in the comment

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: Extends the v1 draft (Slack only).
- Spec: `docs/SPEC.ko.md`

## Context

Re-runs on every push must not spam channels, and the system is stateless (no server, no DB).

## Decision

Publish one marker PR comment (`<!-- qa-ticket-generator:report -->`) that is edited in place, plus Slack. Slack bot mode posts a summary parent message and details in a thread, updating/deleting on re-runs; webhook mode only posts a summary. Message timestamps and the last analyzed SHA are persisted in a hidden `<!-- qtg-state:{json} -->` block in the PR comment. Channels fail independently; the Job Summary is always written.

## Consequences

- Works without Slack; no duplicate messages; still stateless.

* Users can corrupt the state block by editing the comment (handled by starting fresh).
