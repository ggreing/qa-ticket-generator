/**
 * Shared pieces of the QA-ticket layout (SPEC §4.6, M3.5): what counts as "action needed", how a
 * requirement label and a one-line expected result are derived. Used by the Markdown and Slack
 * renderers so both show the same tickets. Everything here returns raw text; callers sanitize.
 * Owner: qa-work-session-c(fable).
 */
import type { QaReport } from '../../core/contracts';
import { flatten, truncate } from '../sanitize';

export type Scenario = QaReport['scenarios'][number];
export type Finding = QaReport['prdAlignment']['findings'][number];

/** Top-of-report caps, so the verdict and the P0 actions fit one screen without scrolling. */
export const MAX_ACTION_ITEMS = 8;
export const MAX_CHECKLIST_ITEMS = 10;
export const MAX_REQUIREMENT_CHARS = 90;
export const MAX_EVIDENCE_CHARS = 140;
export const MAX_EXPECTED_CHARS = 100;

// "AC2: text", "REQ-3 - text", "FR 1.2) text"
const LABELLED = /^\s*([A-Za-z]{1,6}[- ]?\d{1,4}(?:\.\d{1,3})?)\s*[:.)–—-]\s*(.+)$/s;

/** Splits "AC2: expired coupons are rejected" into its label and text; label is null when absent. */
export function splitRequirement(requirement: string): { label: string | null; text: string } {
  const flat = flatten(requirement);
  const match = LABELLED.exec(flat);
  return match
    ? { label: (match[1] as string).replace(/\s+/g, ''), text: (match[2] as string).trim() }
    : { label: null, text: flat };
}

/** Findings the author has to act on (requirement not met), in report order. */
export function actionFindings(report: QaReport): Finding[] {
  return report.prdAlignment.findings.filter((f) => f.status === 'missing' || f.status === 'contradicts');
}

/** Findings nobody could judge; shown apart from the action list. */
export function unclearFindings(report: QaReport): Finding[] {
  return report.prdAlignment.findings.filter((f) => f.status === 'unclear');
}

/** Requirement labels a scenario verifies, e.g. `["AC2", "AC4"]`; unlabeled ones are left out. */
export function requirementLabels(scenario: Scenario): string[] {
  const labels = scenario.relatedRequirements
    .map((r) => splitRequirement(r).label)
    .filter((l): l is string => l !== null);
  return [...new Set(labels)];
}

/** The tag after a ticket title: `P0 · AC2, AC4`, or just `P0`. */
export function ticketTag(scenario: Scenario): string {
  const labels = requirementLabels(scenario);
  return labels.length > 0 ? `${scenario.priority} · ${labels.join(', ')}` : scenario.priority;
}

/** One-line expected result for the checklist: the first `then`, shortened. */
export function expectedSummary(scenario: Scenario): string {
  const first = scenario.then.map(flatten).find((line) => line !== '') ?? '';
  return truncate(first, MAX_EXPECTED_CHARS);
}

export const nonEmpty = (items: string[]): string[] => items.map(flatten).filter((item) => item !== '');
