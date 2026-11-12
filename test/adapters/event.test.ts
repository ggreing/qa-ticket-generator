import { describe, expect, it } from 'vitest';
import { prNumberOf, toTriggerEvent } from '../../src/adapters/event';

const pr = (over: Record<string, unknown> = {}) => ({
  number: 12,
  state: 'open',
  draft: false,
  labels: [{ name: 'needs-ai-qa' }, { name: 'bug' }],
  head: { repo: { full_name: 'acme/shop' } },
  base: { repo: { full_name: 'acme/shop' } },
  ...over,
});

describe('toTriggerEvent', () => {
  it('maps a labeled pull_request payload', () => {
    const e = toTriggerEvent('pull_request', {
      action: 'labeled',
      label: { name: 'needs-ai-qa' },
      pull_request: pr(),
    });
    expect(e).toEqual({
      name: 'pull_request',
      action: 'labeled',
      addedLabel: 'needs-ai-qa',
      pr: { number: 12, state: 'open', labels: ['needs-ai-qa', 'bug'], isFork: false, draft: false },
    });
    expect(prNumberOf(e)).toBe(12);
  });

  it('detects forks, including deleted head repos', () => {
    expect(
      toTriggerEvent('pull_request', { pull_request: pr({ head: { repo: { full_name: 'evil/shop' } } }) }).pr
        ?.isFork,
    ).toBe(true);
    expect(toTriggerEvent('pull_request', { pull_request: pr({ head: { repo: null } }) }).pr?.isFork).toBe(
      true,
    );
    expect(toTriggerEvent('pull_request', { pull_request: pr({ state: 'closed' }) }).pr?.state).toBe(
      'closed',
    );
  });

  it('reads the workflow_dispatch pr-number input', () => {
    const e = toTriggerEvent('workflow_dispatch', { inputs: { 'pr-number': '34' } });
    expect(e.dispatchPrNumber).toBe(34);
    expect(prNumberOf(e)).toBe(34);
    expect(
      toTriggerEvent('workflow_dispatch', { inputs: { 'pr-number': 'abc' } }).dispatchPrNumber,
    ).toBeUndefined();
    expect(toTriggerEvent('push', { inputs: { 'pr-number': '3' } }).dispatchPrNumber).toBeUndefined();
  });
});
