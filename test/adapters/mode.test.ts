import { describe, expect, it } from 'vitest';
import { toTriggerEvent } from '../../src/adapters/event';
import { decideMode, type ModeOptions, parseSpecRef } from '../../src/adapters/mode';

const o: ModeOptions = {
  mode: 'auto',
  spec: null,
  planLabel: 'needs-qa-plan',
  owner: 'acme',
  repo: 'shop',
  jiraProjectKeys: [],
};

const issueLabeled = (label: string, state = 'open') =>
  toTriggerEvent('issues', {
    action: 'labeled',
    label: { name: label },
    issue: { number: 12, state, labels: [{ name: label }] },
  });

describe('parseSpecRef (SPEC v3 §7)', () => {
  it('reads issue numbers, Jira keys and URLs', () => {
    expect(parseSpecRef('12', o)).toMatchObject({ source: 'github', id: 'acme/shop#12' });
    expect(parseSpecRef('#7', o)).toMatchObject({ source: 'github', id: 'acme/shop#7' });
    expect(parseSpecRef('proj-123', o)).toMatchObject({ source: 'jira', id: 'PROJ-123' });
    expect(parseSpecRef('https://github.com/other/repo/issues/3', o)).toMatchObject({
      source: 'github',
      id: 'other/repo#3',
    });
    expect(parseSpecRef('https://acme.atlassian.net/browse/PAY-9', o)).toMatchObject({
      source: 'jira',
      id: 'PAY-9',
    });
    expect(
      parseSpecRef('https://www.notion.so/acme/Coupon-0123456789abcdef0123456789abcdef', o),
    ).toMatchObject({ source: 'notion', id: '0123456789abcdef0123456789abcdef' });
  });

  it('rejects text it cannot read', () => {
    expect(() => parseSpecRef('the coupon doc', o)).toThrow(/Cannot read the spec/);
    expect(() => parseSpecRef('0', o)).toThrow();
  });
});

describe('decideMode (SPEC v3 §2)', () => {
  it('plans when the plan label is added to an open issue', () => {
    expect(decideMode(issueLabeled('needs-qa-plan'), o)).toMatchObject({
      mode: 'plan',
      spec: { id: 'acme/shop#12' },
    });
    expect(decideMode(issueLabeled('bug'), o)).toEqual({ mode: 'skip', reason: 'irrelevant_label' });
    expect(decideMode(issueLabeled('needs-qa-plan', 'closed'), o)).toEqual({
      mode: 'skip',
      reason: 'closed',
    });
    expect(decideMode(toTriggerEvent('issues', { action: 'opened', issue: { number: 1 } }), o)).toEqual({
      mode: 'skip',
      reason: 'unsupported_event',
    });
  });

  it('ignores issue payloads that belong to pull requests', () => {
    const ev = toTriggerEvent('issues', {
      action: 'labeled',
      label: { name: 'needs-qa-plan' },
      issue: { number: 5, pull_request: {} },
    });
    expect(decideMode(ev, o)).toEqual({ mode: 'skip', reason: 'unsupported_event' });
  });

  it('plans from the spec input of a manual run, verifies PR events', () => {
    const dispatch = toTriggerEvent('workflow_dispatch', { inputs: { spec: 'PAY-9' } });
    expect(decideMode(dispatch, o)).toMatchObject({ mode: 'plan', spec: { source: 'jira', id: 'PAY-9' } });
    const pr = toTriggerEvent('pull_request', {
      action: 'labeled',
      label: { name: 'needs-ai-qa' },
      pull_request: { number: 3, state: 'open', labels: [] },
    });
    expect(decideMode(pr, o)).toEqual({ mode: 'verify' });
    // a manual run with both spec and pr-number is a PR run
    const both = toTriggerEvent('workflow_dispatch', { inputs: { spec: 'PAY-9', 'pr-number': '3' } });
    expect(decideMode(both, o)).toEqual({ mode: 'verify' });
  });

  it('honours explicit modes', () => {
    expect(decideMode(issueLabeled('needs-qa-plan'), { ...o, mode: 'verify' })).toEqual({ mode: 'verify' });
    expect(decideMode(toTriggerEvent('push', {}), { ...o, mode: 'plan', spec: '#4' })).toMatchObject({
      mode: 'plan',
      spec: { id: 'acme/shop#4' },
    });
    expect(() => decideMode(toTriggerEvent('push', {}), { ...o, mode: 'plan' })).toThrow(/no spec/);
  });
});
