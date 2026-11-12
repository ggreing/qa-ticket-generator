/**
 * Shared pieces of the QA-ticket layout (SPEC §4.6, M3.5): what counts as "action needed", how a
 * requirement label and a one-line expected result are derived. Used by the Markdown and Slack
 * renderers so both show the same tickets. Everything here returns raw text; callers sanitize.
 * Owner: qa-work-session-c(fable).
 */
import type { QaReport } from '../../core/contracts';
import { flatten } from '../sanitize';

export type Scenario = QaReport['scenarios'][number];
export type Finding = QaReport['prdAlignment']['findings'][number];

/** Top-of-report caps, so the verdict and the P0 actions fit one screen without scrolling. */
export const MAX_ACTION_ITEMS = 8;
export const MAX_CHECKLIST_ITEMS = 10;
export const MAX_REQUIREMENT_CHARS = 60;
export const MAX_EVIDENCE_CHARS = 160;
export const MAX_EXPECTED_CHARS = 100;
/** Requirement labels shown after a ticket title before the rest is folded into "+N". */
export const MAX_TAG_LABELS = 3;

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

// The whole value is a label: "AC2", "REQ-3", "FR 1.2".
const BARE_LABEL = /^\s*([A-Za-z]{1,6}[- ]?\d{1,4}(?:\.\d{1,3})?)\s*$/;
// A requirement label somewhere inside a sentence: "verifies AC2 (expiry)".
const INLINE_LABEL = /\b(AC|REQ|FR|NFR|US)[- ]?(\d{1,4}(?:\.\d{1,3})?)\b/i;
// A tracker key or an issue reference, for PRDs that have no numbered criteria.
const TRACKER_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/;
const ISSUE_REF = /(?:^|[\s(/])(?:[\w.-]+\/[\w.-]+)?(#\d{1,7})\b/;

/**
 * The short name of the requirement a scenario cites, however the model wrote it: "AC2",
 * "AC2: text", a sentence that mentions AC2, a tracker key, or an issue reference.
 * Null when the text names nothing short.
 */
export function requirementLabel(requirement: string): string | null {
  const flat = flatten(requirement);
  const labelled = splitRequirement(flat).label;
  if (labelled) return labelled;
  const bare = BARE_LABEL.exec(flat);
  if (bare) return (bare[1] as string).replace(/\s+/g, '');
  const inline = INLINE_LABEL.exec(flat);
  if (inline) return `${(inline[1] as string).toUpperCase()}${inline[2]}`;
  return TRACKER_KEY.exec(flat)?.[1] ?? ISSUE_REF.exec(flat)?.[1] ?? null;
}

/** Requirement labels a scenario verifies, e.g. `["AC2", "AC4"]`; requirements without one are left out. */
export function requirementLabels(scenario: Scenario): string[] {
  const labels = scenario.relatedRequirements.map(requirementLabel).filter((l): l is string => l !== null);
  return [...new Set(labels)];
}

/** The tag after a ticket title: `P0 · AC2, AC4`, or just `P0` when no requirement is named. */
export function ticketTag(scenario: Scenario): string {
  const labels = requirementLabels(scenario);
  if (labels.length === 0) return scenario.priority;
  const shown = labels.slice(0, MAX_TAG_LABELS).join(', ');
  const more = labels.length > MAX_TAG_LABELS ? ` +${labels.length - MAX_TAG_LABELS}` : '';
  return `${scenario.priority} · ${shown}${more}`;
}

const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|cf|approx|no|fig|ex)\.$/i;
const backticksBalanced = (text: string): boolean => (text.match(/`/g)?.length ?? 0) % 2 === 0;

/** The first sentence of `text`. A full stop inside a file name, a number, an abbreviation or code is not an end. */
export function firstSentence(text: string): string {
  const flat = flatten(text);
  const end = /[.!?](?=\s+\S)|[。！？](?=.)/g;
  for (let m = end.exec(flat); m !== null; m = end.exec(flat)) {
    const candidate = flat.slice(0, m.index + 1);
    if (ABBREVIATION.test(candidate) || /^\d+\.$/.test(candidate) || !backticksBalanced(candidate)) continue;
    return candidate;
  }
  return flat;
}

/**
 * Cuts `text` to at most `max` characters at a word boundary and ends it with an ellipsis.
 * A code span that would be cut in half is dropped whole, so no backtick is left unpaired.
 */
export function shorten(text: string, max: number): string {
  const flat = flatten(text);
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(' ');
  if (space >= max * 0.6) cut = cut.slice(0, space);
  if (!backticksBalanced(cut)) cut = cut.slice(0, cut.lastIndexOf('`'));
  return `${cut.replace(/[\s,;:·—–(-]+$/, '')}…`;
}

/** What the top lists show of a longer text: its first sentence, shortened only if that is still too long. */
export function lead(text: string, max: number): string {
  return shorten(firstSentence(text), max);
}

/**
 * One-line expected result for the checklist: the first `then`. The prompt asks for the deciding
 * observation to come first, so this is the line that tells pass from fail.
 */
export function expectedSummary(scenario: Scenario): string {
  const first = scenario.then.map(flatten).find((line) => line !== '') ?? '';
  return shorten(first, MAX_EXPECTED_CHARS);
}

export const nonEmpty = (items: string[]): string[] => items.map(flatten).filter((item) => item !== '');
