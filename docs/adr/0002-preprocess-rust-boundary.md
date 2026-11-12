# ADR-0002: Isolate preprocessing behind a pure, JSON contract (Rust boundary)

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: New.
- Spec: `docs/SPEC.ko.md`

## Context

Preprocessing (diff parsing, AST expansion, secret redaction, scoring, packing) is the only CPU-bound part and the only plausible candidate for a future Rust/WASM rewrite.

## Decision

`src/preprocess` exposes `createPreprocessEngine(opts): Promise<PreprocessEngine>` whose `run(input): output` is synchronous, deterministic and I/O-free. Inputs and outputs are JSON-serializable (`src/core/contracts.ts`). Shared golden fixtures in `fixtures/preprocess/` define behaviour; any implementation must pass them.

## Consequences

- The module can be swapped for Rust/WASM without touching the rest.

* File contents must be fetched before preprocessing, even if later dropped by the budget.
