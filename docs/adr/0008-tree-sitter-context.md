# ADR-0008: tree-sitter (WASM) to expand changes to their enclosing symbol

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: New (makes the v1 'AST' idea concrete).
- Spec: `docs/SPEC.ko.md`

## Context

Bare diffs lack the surrounding function, which leads to guessing; the GitHub API does not provide ASTs.

## Decision

Fetch head file contents and use `web-tree-sitter` with bundled grammars (TS/TSX/JS/Python/Java/Go) to include the enclosing function/method/class (max 300 lines, otherwise signature + ±20 lines). Fall back to ±20 lines when parsing fails or the language is unsupported.

## Consequences

- Much better context per token.

* A few MB of WASM grammars in the bundle; per-language queries to maintain.
