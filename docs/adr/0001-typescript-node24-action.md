# ADR-0001: TypeScript + Node 24 JavaScript Action

- Status: Accepted (2026-11-12)
- Relation to the v1 draft: Supersedes the Python plan in the v1 draft.
- Spec: `docs/SPEC.ko.md`

## Context

The tool spends >95% of its wall time waiting on network APIs (GitHub, Jira, Notion, Anthropic, Slack), so runtime speed is not a differentiator. What matters is ecosystem fit and zero-install startup on Actions runners. Rust and Python were evaluated.

## Decision

Implement in TypeScript (strict, ESM), ship as a `node24` JavaScript Action bundled with esbuild, and publish the same core as an npm CLI. Use the official SDKs: `@anthropic-ai/sdk`, `@actions/core`, `@actions/github` (Octokit).

## Consequences

- No install step on runners; official SDKs; largest contributor pool.

* `dist/` must be built and committed on release tags; tree-sitter runs as WASM.
* Rust's single-binary benefit is deferred to the preprocess module only (ADR-0002).
