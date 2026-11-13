/**
 * Case sync engine (SPEC v3 §4) and case text rendering (§3.1). Pure, no I/O.
 * Owner: qa-work-session-b.
 */

import type { LintCaseStyle, PlanSync, QaCase, ReconcileCases, RenderedCase } from '../core/cases';
import type { Language } from '../core/contracts';
import { notImplemented } from '../core/stub';

/** §4.1 — validate reused ids, assign new ones (`<specKey>-C<nn>`), carry obsolete cases. */
export const reconcileCases: ReconcileCases = (_specRef, _existing, _planned) =>
  notImplemented('cases/reconcileCases');

/** §4.2–§4.5 — create / update / suggest / obsolete / unchanged ops for one sink. */
export const planSync: PlanSync = (_existing, _next, _render) => notImplemented('cases/planSync');

/** §3.1 — render a case for sinks (title, markdown body, fields, hash of tool-owned text). */
export function renderCase(_c: QaCase, _language: Language): RenderedCase {
  return notImplemented('cases/renderCase');
}

/** §3.1 — deterministic AI-style lint (banned phrases, explanatory voice). */
export const lintCaseStyle: LintCaseStyle = (_c, _language) => notImplemented('cases/lintCaseStyle');
