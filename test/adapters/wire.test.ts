import { describe, expect, it } from 'vitest';
import { redactText } from '../../src/adapters/wire';

describe('wire redactText (PRE-05 for PR title/body)', () => {
  it('redacts secrets and counts them', () => {
    const r = redactText('deploy with token ghp_' + 'a'.repeat(36) + ' please');
    expect(r.text).toContain('[REDACTED:github_token]');
    expect(r.text).not.toContain('ghp_a');
    expect(r.redactions).toEqual([{ type: 'github_token', count: 1 }]);
  });

  it('does not count markers that were already in the text', () => {
    const r = redactText('see [REDACTED:github_token] in the old PR');
    expect(r.redactions).toEqual([]);
  });
});
