/**
 * Case sync engine (SPEC v3 §4) and case text rendering (§3.1). Pure, no I/O.
 * Owner: qa-work-session-b.
 *
 * Shared with other modules: labels (sinks, prompts), STYLE_RULES (prompts), the Markdown subset
 * and hash rule of renderCase (sinks; see src/cases/render.ts and src/cases/sync.ts).
 */

export {
  CODE_STATUS_LABELS,
  OBSOLETE_LABEL,
  PRIORITIES,
  SECTION_LABELS,
  SPEC_GAP_PREFIX,
  TECHNIQUE_LABELS,
} from './labels';
export { caseIdFor, caseNumber, compareCaseIds, reconcileCases, specKey, toQaCase } from './reconcile';
export { MAX_TITLE_LENGTH, mdSafe, plainTitle, renderCase, renderTitle, toolTextHash } from './render';
export { type CaseTextField, displayLength, lintCaseStyle, STYLE_RULES, type StyleRule } from './style';
export { planSync } from './sync';
export { applyVerify } from './verify-merge';
