/**
 * Preprocess engine (SPEC §5.4, PRE-01..10) — Rust boundary.
 * Rules: no I/O inside `run` (no fs/network/env/clock/random), JSON-serializable inputs/outputs only.
 * Owner: qa-work-session-b.
 */
import type { CreatePreprocessEngine, IsNoisePath } from '../core/contracts';
import { notImplemented } from '../core/stub';

export const createPreprocessEngine: CreatePreprocessEngine = async (_options) =>
  notImplemented('preprocess/createPreprocessEngine');

export const isNoisePath: IsNoisePath = (_path, _options) => notImplemented('preprocess/isNoisePath');
