# ADR-0007: Noise filtering, priority packing, conditional map-reduce and a per-run cost cap

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: Extends v1 ADR-003.
- Spec: `docs/SPEC.ko.md`

## Context

Large PRs can exceed a sensible per-call budget, and map-reduce multiplies calls, so per-call limits alone do not bound cost.

## Decision

Drop noise (lock files, binaries, build output, generated code) but summarise dependency/config changes. Score files (PRD keyword match, change size, domain paths, test/config penalty) and pack them into `token-budget` per call; split into map-reduce chunks only when it does not fit. Bound each run by `max-cost-usd` (default $2.00), estimated before calling and dropping lowest-priority chunks first; every dropped file is listed in the report.

## Consequences

- One call for typical PRs; bounded spend for huge ones; transparent coverage gaps.

* Estimates are approximate (chars/3.2 heuristic + price table).
