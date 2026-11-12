/**
 * Preprocess engine (SPEC §5.4, PRE-01..10) — Rust boundary.
 * Rules: no I/O inside `run` (no fs/network/env/clock/random), JSON-serializable inputs/outputs only.
 * Behaviour is specified by the golden fixtures in `fixtures/preprocess/*.json`.
 * Owner: qa-work-session-b.
 */
import type { CreatePreprocessEngine, IsNoisePath, PreprocessEngine } from '../core/contracts';
import { type AstRuntime, loadAstRuntime } from './ast/runtime';
import { runPreprocess } from './engine';
import { classifyPath } from './noise';

/** {@link PreprocessEngine} plus load diagnostics (not part of the shared contract). */
export interface PreprocessEngineWithDiagnostics extends PreprocessEngine {
  /** Languages whose tree-sitter grammar loaded; others use ±20 line contexts. */
  readonly astLanguages: string[];
  /** Grammar load problems (empty when everything loaded). */
  readonly astErrors: string[];
}

/** Builds an engine from an already loaded AST runtime (tests and alternative loaders). */
export function engineFromRuntime(ast: AstRuntime): PreprocessEngineWithDiagnostics {
  return {
    run: (input) => runPreprocess(input, ast),
    astLanguages: [...ast.parsers.keys()],
    astErrors: [...ast.errors],
  };
}

/**
 * PRE-01 — creates the preprocessing engine. Loads web-tree-sitter and the grammars for
 * `astLanguages` once (the only async / I/O step); grammar failures never throw, they degrade
 * the affected languages to line contexts. The returned `run` is synchronous and pure.
 */
export const createPreprocessEngine: CreatePreprocessEngine = async (options) =>
  engineFromRuntime(await loadAstRuntime(options.astLanguages));

/**
 * TRG-04 helper — true when `path` would be dropped by the PRE-02 path rules (built-in list,
 * `exclude`, minus `include`). Content-based rules (generated headers) are not evaluated.
 */
export const isNoisePath: IsNoisePath = (path, options) => classifyPath(path, options) !== null;
