# ADR-0009: Security: no checkout, fork PRs opt-in, sanitized output, secret redaction

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: New.
- Spec: `docs/SPEC.ko.md`

## Context

The action handles secrets and untrusted PR content and posts LLM output to shared channels.

## Decision

Never check out or execute PR code; read everything via APIs. Default to `pull_request` and skip fork PRs; provide a documented `pull_request_target` opt-in. Read the repo config from the base branch. Redact secrets before anything reaches the LLM. Treat LLM output as data: escape HTML/mrkdwn, neutralise mentions, allow-list links. Minimal workflow permissions.

## Consequences

- No pwn-request path; prompt injection cannot trigger actions.

* Fork PRs need extra setup.
