/**
 * SPEC v3 §2, §7 — which phase a run is: plan (spec -> cases) or verify (PR -> code status).
 * Pure, testable. OWNERSHIP: control session.
 */
import { extractPrdRefs } from '../context/prd/refs';
import type { PrdRef, TriggerEvent } from '../core/contracts';
import { QtgError } from '../core/errors';

export type ModeDecision =
  | { mode: 'plan'; spec: PrdRef }
  | { mode: 'verify' }
  | { mode: 'skip'; reason: 'irrelevant_label' | 'closed' | 'unsupported_event' };

export interface ModeOptions {
  mode: 'auto' | 'plan' | 'verify';
  /** `spec` input (manual runs, CLI). */
  spec: string | null;
  planLabel: string;
  owner: string;
  repo: string;
  jiraProjectKeys: string[];
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const ISSUE_NUMBER = /^#?(\d+)$/;

/**
 * Turns a spec reference typed by a person into a PrdRef: `12` / `#12` (issue in this repo),
 * `PROJ-123` (any Jira key: the person named it explicitly), or a GitHub / Jira / Notion URL.
 */
export function parseSpecRef(
  raw: string,
  o: Pick<ModeOptions, 'owner' | 'repo' | 'jiraProjectKeys'>,
): PrdRef {
  const text = raw.trim();
  const num = text.match(ISSUE_NUMBER)?.[1];
  if (num && Number(num) > 0) {
    const n = String(Number(num));
    return {
      source: 'github',
      id: `${o.owner}/${o.repo}#${n}`,
      url: `https://github.com/${o.owner}/${o.repo}/issues/${n}`,
      raw: text,
    };
  }
  const key = text.toUpperCase();
  if (JIRA_KEY.test(key)) return { source: 'jira', id: key, raw: text };
  const [ref] = extractPrdRefs(text, {
    defaultOwner: o.owner,
    defaultRepo: o.repo,
    jiraProjectKeys: o.jiraProjectKeys,
    maxDocuments: 1,
  });
  if (!ref) {
    throw new QtgError(
      'config_invalid',
      `Cannot read the spec "${text}". Use an issue number, a Jira key, or a GitHub / Jira / Notion URL.`,
    );
  }
  return ref;
}

export function decideMode(event: TriggerEvent, o: ModeOptions): ModeDecision {
  const explicitSpec = o.spec ?? event.dispatchSpec ?? null;

  if (o.mode === 'verify') return { mode: 'verify' };
  if (o.mode === 'plan') {
    if (explicitSpec) return { mode: 'plan', spec: parseSpecRef(explicitSpec, o) };
    if (event.issue) return { mode: 'plan', spec: parseSpecRef(String(event.issue.number), o) };
    throw new QtgError('config_invalid', 'mode is "plan" but no spec was given. Set the "spec" input.');
  }

  // auto
  if (event.name === 'issues') {
    if (!event.issue) return { mode: 'skip', reason: 'unsupported_event' };
    if (event.action !== 'labeled') return { mode: 'skip', reason: 'unsupported_event' };
    if (event.addedLabel !== o.planLabel) return { mode: 'skip', reason: 'irrelevant_label' };
    if (event.issue.state === 'closed') return { mode: 'skip', reason: 'closed' };
    return { mode: 'plan', spec: parseSpecRef(String(event.issue.number), o) };
  }
  if (explicitSpec && !event.pr && !event.dispatchPrNumber) {
    return { mode: 'plan', spec: parseSpecRef(explicitSpec, o) };
  }
  return { mode: 'verify' };
}
