import { describe, expect, it } from 'vitest';
import { CliUsageError, cliInputReader, parseArgs } from '../../src/adapters/cli-args';

describe('parseArgs', () => {
  it('parses a run command with defaults (dry-run, md)', () => {
    expect(parseArgs(['run', '--repo', 'acme/shop', '--pr', '42'])).toEqual({
      command: 'run',
      repo: { owner: 'acme', repo: 'shop' },
      pr: 42,
      publish: false,
      format: 'md',
      inputs: {},
    });
  });

  it('accepts --flag=value, --publish and input flags', () => {
    const a = parseArgs([
      'run',
      '--repo=acme/shop',
      '--pr=7',
      '--publish',
      '--format',
      'json',
      '--out',
      'r.json',
      '--language',
      'kr',
      '--max-cost-usd',
      '0.5',
    ]);
    expect(a).toMatchObject({
      publish: true,
      format: 'json',
      out: 'r.json',
      inputs: { language: 'kr', 'max-cost-usd': '0.5' },
    });
  });

  it('returns help/version commands', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-v']).command).toBe('version');
    expect(parseArgs(['run', '--repo', 'a/b', '--help']).command).toBe('help');
  });

  it.each([
    [['deploy']],
    [['run', '--pr', '1']],
    [['run', '--repo', 'a/b']],
    [['run', '--repo', 'nope', '--pr', '1']],
    [['run', '--repo', 'a/b', '--pr', '0']],
    [['run', '--repo', 'a/b', '--pr', '1', '--format', 'html']],
    [['run', '--repo', 'a/b', '--pr', '1', '--unknown', 'x']],
    [['run', '--repo', 'a/b', '--pr']],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(CliUsageError);
  });
});

describe('cliInputReader', () => {
  it('maps flags, then env vars; dry-run follows --publish', () => {
    const args = parseArgs(['run', '--repo', 'a/b', '--pr', '1', '--model', 'claude-sonnet-5-5']);
    const read = cliInputReader(args, { ANTHROPIC_API_KEY: 'sk', MAX_SCENARIOS: '5', MODEL: 'ignored' });
    expect(read('model')).toBe('claude-sonnet-5-5');
    expect(read('anthropic-api-key')).toBe('sk');
    expect(read('max-scenarios')).toBe('5');
    expect(read('slack-bot-token')).toBe('');
    expect(read('dry-run')).toBe('true');
    expect(cliInputReader({ ...args, publish: true }, {})('dry-run')).toBe('false');
  });
});
