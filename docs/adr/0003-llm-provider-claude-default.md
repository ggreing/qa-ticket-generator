# ADR-0003: LLM provider interface with Claude Opus 5.5 by default

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: Refines the v1 draft.
- Spec: `docs/SPEC.ko.md`

## Context

Output must be machine-parseable to render Slack/PR content reliably, and quality of edge-case reasoning is the product.

## Decision

Define `LlmProvider` in core; v1 implements Anthropic via the official SDK using Structured Outputs (`messages.parse` + zod schema). Default model `claude-opus-5-5`, effort `high` (to be re-evaluated against `medium` with the eval set), adaptive thinking, streaming for long outputs, server-side refusal fallback on by default (`server-fallback` input).

## Consequences

- Schema-valid output without brittle parsing; one vendor to test well.

* Users without an Anthropic key cannot use v1; other providers come later behind the same interface.
