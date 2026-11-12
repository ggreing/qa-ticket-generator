import { describe, expect, it } from 'vitest';
import type { TriggerDecision, TriggerEvent } from '../../src/core/contracts';
import { decideTrigger } from '../../src/trigger/gate';

const LABEL = 'needs-ai-qa';
const defaults = { triggerLabel: LABEL, rerunOnPush: true, allowForkPrs: false };

function pr(over: Partial<NonNullable<TriggerEvent['pr']>> = {}): NonNullable<TriggerEvent['pr']> {
  return { number: 7, state: 'open', labels: [LABEL], isFork: false, draft: false, ...over };
}

const RUN: TriggerDecision = { run: true };
const skip = (reason: TriggerDecision['reason']): TriggerDecision => ({ run: false, reason });

interface Row {
  name: string;
  event: TriggerEvent;
  options?: Partial<typeof defaults>;
  expected: TriggerDecision;
}

// SPEC §5.1 decision table, one block per row.
const rows: Row[] = [
  // pull_request.labeled
  {
    name: 'labeled with the trigger label → run',
    event: { name: 'pull_request', action: 'labeled', addedLabel: LABEL, pr: pr() },
    expected: RUN,
  },
  {
    name: 'labeled with the trigger label in another case → run',
    event: { name: 'pull_request', action: 'labeled', addedLabel: 'Needs-AI-QA', pr: pr() },
    expected: RUN,
  },
  {
    name: 'labeled with another label → irrelevant_label',
    event: { name: 'pull_request', action: 'labeled', addedLabel: 'bug', pr: pr() },
    expected: skip('irrelevant_label'),
  },
  {
    name: 'labeled without a label name → irrelevant_label',
    event: { name: 'pull_request', action: 'labeled', pr: pr() },
    expected: skip('irrelevant_label'),
  },
  // pull_request.synchronize
  {
    name: 'synchronize with label and rerun-on-push → run',
    event: { name: 'pull_request', action: 'synchronize', pr: pr() },
    expected: RUN,
  },
  {
    name: 'synchronize without the label → label_absent',
    event: { name: 'pull_request', action: 'synchronize', pr: pr({ labels: ['bug'] }) },
    expected: skip('label_absent'),
  },
  {
    name: 'synchronize with rerun-on-push=false → rerun_disabled',
    event: { name: 'pull_request', action: 'synchronize', pr: pr() },
    options: { rerunOnPush: false },
    expected: skip('rerun_disabled'),
  },
  {
    name: 'synchronize without label and rerun-on-push=false → label_absent',
    event: { name: 'pull_request', action: 'synchronize', pr: pr({ labels: [] }) },
    options: { rerunOnPush: false },
    expected: skip('label_absent'),
  },
  // pull_request.opened / reopened
  {
    name: 'opened with label → run',
    event: { name: 'pull_request', action: 'opened', pr: pr() },
    expected: RUN,
  },
  {
    name: 'reopened with label → run',
    event: { name: 'pull_request', action: 'reopened', pr: pr() },
    expected: RUN,
  },
  {
    name: 'opened without label → label_absent',
    event: { name: 'pull_request', action: 'opened', pr: pr({ labels: [] }) },
    expected: skip('label_absent'),
  },
  {
    name: 'reopened without label → label_absent',
    event: { name: 'pull_request', action: 'reopened', pr: pr({ labels: ['wip'] }) },
    expected: skip('label_absent'),
  },
  {
    name: 'reopened with label ignores rerun-on-push=false (not a push)',
    event: { name: 'pull_request', action: 'reopened', pr: pr() },
    options: { rerunOnPush: false },
    expected: RUN,
  },
  // pull_request.* closed
  {
    name: 'labeled on a closed PR → closed',
    event: { name: 'pull_request', action: 'labeled', addedLabel: LABEL, pr: pr({ state: 'closed' }) },
    expected: skip('closed'),
  },
  {
    name: 'synchronize on a closed PR → closed',
    event: { name: 'pull_request', action: 'synchronize', pr: pr({ state: 'closed' }) },
    expected: skip('closed'),
  },
  {
    name: 'closed action → closed',
    event: { name: 'pull_request', action: 'closed', pr: pr({ state: 'closed' }) },
    expected: skip('closed'),
  },
  // pull_request.* fork & !allow-fork-prs
  {
    name: 'fork PR labeled without allow-fork-prs → fork_pr',
    event: { name: 'pull_request', action: 'labeled', addedLabel: LABEL, pr: pr({ isFork: true }) },
    expected: skip('fork_pr'),
  },
  {
    name: 'fork PR synchronize without allow-fork-prs → fork_pr',
    event: { name: 'pull_request', action: 'synchronize', pr: pr({ isFork: true }) },
    expected: skip('fork_pr'),
  },
  {
    name: 'closed beats fork_pr',
    event: {
      name: 'pull_request',
      action: 'labeled',
      addedLabel: LABEL,
      pr: pr({ isFork: true, state: 'closed' }),
    },
    expected: skip('closed'),
  },
  // pull_request_target.* with allow-fork-prs=true → same rules
  {
    name: 'pull_request_target labeled fork PR with allow-fork-prs → run',
    event: { name: 'pull_request_target', action: 'labeled', addedLabel: LABEL, pr: pr({ isFork: true }) },
    options: { allowForkPrs: true },
    expected: RUN,
  },
  {
    name: 'pull_request_target other label with allow-fork-prs → irrelevant_label',
    event: { name: 'pull_request_target', action: 'labeled', addedLabel: 'x', pr: pr({ isFork: true }) },
    options: { allowForkPrs: true },
    expected: skip('irrelevant_label'),
  },
  {
    name: 'pull_request_target synchronize (same repo) with allow-fork-prs → run',
    event: { name: 'pull_request_target', action: 'synchronize', pr: pr() },
    options: { allowForkPrs: true },
    expected: RUN,
  },
  {
    name: 'pull_request_target closed with allow-fork-prs → closed',
    event: { name: 'pull_request_target', action: 'labeled', addedLabel: LABEL, pr: pr({ state: 'closed' }) },
    options: { allowForkPrs: true },
    expected: skip('closed'),
  },
  {
    name: 'pull_request_target without allow-fork-prs → unsupported_event',
    event: { name: 'pull_request_target', action: 'labeled', addedLabel: LABEL, pr: pr() },
    expected: skip('unsupported_event'),
  },
  // SPEC §11: opted-in fork PRs run only when the label is added.
  {
    name: 'opted-in fork PR synchronize → fork_pr (label attach only)',
    event: { name: 'pull_request_target', action: 'synchronize', pr: pr({ isFork: true }) },
    options: { allowForkPrs: true },
    expected: skip('fork_pr'),
  },
  {
    name: 'opted-in fork PR reopened → fork_pr (label attach only)',
    event: { name: 'pull_request_target', action: 'reopened', pr: pr({ isFork: true }) },
    options: { allowForkPrs: true },
    expected: skip('fork_pr'),
  },
  {
    name: 'opted-in fork PR on pull_request synchronize → fork_pr',
    event: { name: 'pull_request', action: 'synchronize', pr: pr({ isFork: true }) },
    options: { allowForkPrs: true },
    expected: skip('fork_pr'),
  },
  // workflow_dispatch
  {
    name: 'workflow_dispatch with pr-number → run',
    event: { name: 'workflow_dispatch', dispatchPrNumber: 12 },
    expected: RUN,
  },
  {
    name: 'workflow_dispatch without pr-number → unsupported_event',
    event: { name: 'workflow_dispatch' },
    expected: skip('unsupported_event'),
  },
  {
    name: 'workflow_dispatch with pr-number 0 → unsupported_event',
    event: { name: 'workflow_dispatch', dispatchPrNumber: 0 },
    expected: skip('unsupported_event'),
  },
  // anything else
  {
    name: 'push event → unsupported_event',
    event: { name: 'push' },
    expected: skip('unsupported_event'),
  },
  {
    name: 'pull_request.edited → unsupported_event',
    event: { name: 'pull_request', action: 'edited', pr: pr() },
    expected: skip('unsupported_event'),
  },
  {
    name: 'pull_request.unlabeled → unsupported_event',
    event: { name: 'pull_request', action: 'unlabeled', pr: pr() },
    expected: skip('unsupported_event'),
  },
  {
    name: 'pull_request without PR payload → unsupported_event',
    event: { name: 'pull_request', action: 'labeled', addedLabel: LABEL },
    expected: skip('unsupported_event'),
  },
];

describe('decideTrigger', () => {
  it.each(rows)('TRG-01/02 $name', ({ event, options, expected }) => {
    expect(decideTrigger(event, { ...defaults, ...options })).toEqual(expected);
  });

  it('TRG-02 is pure: same input, same output, input untouched', () => {
    const event: TriggerEvent = { name: 'pull_request', action: 'synchronize', pr: pr() };
    const frozen = structuredClone(event);
    expect(decideTrigger(event, defaults)).toEqual(decideTrigger(event, defaults));
    expect(event).toEqual(frozen);
  });

  it('TRG-01 draft PRs follow the same rules', () => {
    expect(
      decideTrigger(
        { name: 'pull_request', action: 'labeled', addedLabel: LABEL, pr: pr({ draft: true }) },
        defaults,
      ),
    ).toEqual(RUN);
  });
});
