/** Webhook payload → TriggerEvent (pure, testable). OWNERSHIP: control session. */
import type { TriggerEvent } from '../core/contracts';

interface LabelLike {
  name?: string;
}

/** Minimal shape of the GitHub webhook payload fields we read. */
export interface PayloadLike {
  action?: string;
  label?: LabelLike;
  inputs?: Record<string, unknown>;
  issue?: { number?: number; state?: string; labels?: LabelLike[]; pull_request?: unknown };
  pull_request?: {
    number?: number;
    state?: string;
    draft?: boolean;
    labels?: LabelLike[];
    head?: { repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
}

export function toTriggerEvent(eventName: string, payload: PayloadLike): TriggerEvent {
  const event: TriggerEvent = { name: eventName };
  if (payload.action) event.action = payload.action;
  if (payload.label?.name) event.addedLabel = payload.label.name;

  const pr = payload.pull_request;
  if (pr?.number) {
    const head = pr.head?.repo?.full_name;
    const base = pr.base?.repo?.full_name;
    event.pr = {
      number: pr.number,
      state: pr.state === 'closed' ? 'closed' : 'open',
      labels: (pr.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
      // A deleted head repo (null) can only be a fork.
      isFork: head === undefined ? pr.head?.repo === null : head !== base,
      draft: pr.draft === true,
    };
  }

  const issue = payload.issue;
  // `issues` events only: issue_comment payloads on PRs also carry `issue`.
  if (eventName === 'issues' && issue?.number && !issue.pull_request) {
    event.issue = {
      number: issue.number,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: (issue.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
    };
  }
  const spec = payload.inputs?.spec;
  if (eventName === 'workflow_dispatch' && typeof spec === 'string' && spec.trim()) {
    event.dispatchSpec = spec.trim();
  }

  const dispatched = Number(payload.inputs?.['pr-number']);
  if (eventName === 'workflow_dispatch' && Number.isInteger(dispatched) && dispatched > 0) {
    event.dispatchPrNumber = dispatched;
  }
  return event;
}

/** PR number the run is about, if any. */
export function prNumberOf(event: TriggerEvent): number | undefined {
  return event.pr?.number ?? event.dispatchPrNumber;
}
