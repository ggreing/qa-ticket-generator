# ADR-0005: PRD sources and behaviour without a linked PRD

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: Relaxes v1 ADR-002 (mandatory PRD).
- Spec: `docs/SPEC.ko.md`

## Context

Cross-checking against the PRD is the core value, but forcing a link on first use blocks adoption.

## Decision

Support GitHub Issues, Jira Cloud and Notion through a `PrdProvider` registry. Without any linked PRD the run continues in code-only mode with a low-confidence badge; `require-prd: true` turns that into a failure.

## Consequences

- Zero-config demo via GitHub Issues; teams opt into strictness.

* Code-only scenarios are less reliable and must be clearly labelled.
