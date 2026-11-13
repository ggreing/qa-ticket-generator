/**
 * Runtime limits shared by the pipeline, the adapters and the eval runner, so cost estimates
 * stay identical everywhere. OWNERSHIP: control session only.
 */

/** LLM-10 — pre-call output estimate per call: ~6K visible JSON + adaptive thinking at high effort. */
export const EXPECTED_OUTPUT_TOKENS = 12_000;
/** Plan-phase calls write a whole case sheet per requirement group: round 0 measured 13k–23k output tokens per call. */
export const PLAN_EXPECTED_OUTPUT_TOKENS = 20_000;

/** LLM-07 — max concurrent map calls in a map-reduce run. */
export const MAP_CONCURRENCY = 3;

/** LLM-03 — `max_tokens` per call (streamed). */
export const MAX_OUTPUT_TOKENS = 32_000;

/** PRD-08 — per-document fetch timeout. */
export const PRD_TIMEOUT_MS = 15_000;
