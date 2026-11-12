/** Trigger gate (SPEC §5.1, TRG-01/02). Owner: qa-work-session-a. */
import type { DecideTrigger, TriggerDecision, TriggerEvent, TriggerSkipReason } from '../core/contracts';

const RUN: TriggerDecision = { run: true };
const skip = (reason: TriggerSkipReason): TriggerDecision => ({ run: false, reason });

/** GitHub label names are unique case-insensitively, so compare them the same way. */
const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * TRG-01/02 — decides whether this event should produce a QA report (SPEC §5.1 decision table).
 *
 * Rules, in order:
 * 1. `workflow_dispatch` runs only when a PR number was supplied.
 * 2. `pull_request_target` is handled like `pull_request` only when `allowForkPrs` is true.
 * 3. Closed PRs skip (`closed`); fork PRs skip unless `allowForkPrs` (`fork_pr`).
 * 4. `labeled` runs only for the trigger label (`irrelevant_label`).
 * 5. `opened`/`reopened` run while the trigger label is present (`label_absent`).
 * 6. `synchronize` runs while the trigger label is present (`label_absent`) and `rerunOnPush` is on
 *    (`rerun_disabled`).
 *
 * Opted-in fork PRs run only when the label is added, never on push/open/reopen (SPEC §11: an outside
 * contributor must not be able to re-trigger a paid run by pushing).
 *
 * @param event Normalized webhook event built by the input adapter.
 * @param options `trigger-label`, `rerun-on-push` and `allow-fork-prs` inputs.
 * @returns `{ run: true }`, or `{ run: false, reason }` with the skip reason.
 */
export const decideTrigger: DecideTrigger = (event, options) => {
  if (event.name === 'workflow_dispatch') {
    return event.dispatchPrNumber !== undefined && event.dispatchPrNumber > 0
      ? RUN
      : skip('unsupported_event');
  }

  const isPrEvent =
    event.name === 'pull_request' || (event.name === 'pull_request_target' && options.allowForkPrs);
  if (!isPrEvent || !event.pr) return skip('unsupported_event');
  return decidePullRequest(event, event.pr, options);
};

function decidePullRequest(
  event: TriggerEvent,
  pr: NonNullable<TriggerEvent['pr']>,
  options: Parameters<DecideTrigger>[1],
): TriggerDecision {
  if (pr.state === 'closed') return skip('closed');
  if (pr.isFork && !options.allowForkPrs) return skip('fork_pr');

  const hasLabel = pr.labels.some((l) => sameLabel(l, options.triggerLabel));

  switch (event.action) {
    case 'labeled':
      return event.addedLabel !== undefined && sameLabel(event.addedLabel, options.triggerLabel)
        ? RUN
        : skip('irrelevant_label');
    case 'opened':
    case 'reopened':
      if (pr.isFork) return skip('fork_pr');
      return hasLabel ? RUN : skip('label_absent');
    case 'synchronize':
      if (pr.isFork) return skip('fork_pr');
      if (!hasLabel) return skip('label_absent');
      return options.rerunOnPush ? RUN : skip('rerun_disabled');
    default:
      return skip('unsupported_event');
  }
}
