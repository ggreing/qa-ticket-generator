import { describe, expect, it } from 'vitest';
import { normalizeLanguage, parseRepoConfig, resolveConfig } from '../../src/core/config';
import { QtgError } from '../../src/core/errors';
import { inputs } from '../helpers/fakes';

const base = { 'anthropic-api-key': 'sk-test', 'github-token': 'gh' };

describe('normalizeLanguage', () => {
  it.each([
    ['en', 'en'],
    ['KO', 'ko'],
    ['kr', 'ko'],
    ['jp', 'ja'],
    ['ja', 'ja'],
    ['zh', 'zh-CN'],
    ['cn', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh_cn', 'zh-CN'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeLanguage(raw)).toBe(expected);
  });

  it('rejects unsupported languages', () => {
    expect(() => normalizeLanguage('fr')).toThrow(QtgError);
  });
});

describe('resolveConfig', () => {
  it('applies spec defaults', () => {
    const cfg = resolveConfig(inputs(base), parseRepoConfig(null));
    expect(cfg).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      language: 'en',
      triggerLabel: 'needs-ai-qa',
      rerunOnPush: true,
      requirePrd: false,
      tokenBudget: 150_000,
      maxCostUsd: 2,
      maxScenarios: 8,
      prComment: true,
      commentAuthor: null,
      slack: { mode: 'off' },
      jira: null,
      notionToken: null,
      failOn: 'none',
      failOnError: false,
      allowForkPrs: false,
      dryRun: false,
      serverFallback: true,
      maxPrdDocuments: 5,
    });
    expect(cfg.preprocess.tokenBudget).toBe(150_000);
  });

  it('requires an API key, also for dry-run (the report is still generated)', () => {
    expect(() => resolveConfig(inputs({}), parseRepoConfig(null))).toThrow(/anthropic-api-key/);
    expect(() => resolveConfig(inputs({ 'dry-run': 'true' }), parseRepoConfig(null))).toThrow(
      /anthropic-api-key/,
    );
  });

  it('v0.2 defaults to the Claude API; Bedrock and Vertex need no Anthropic key and drop one if given', () => {
    const repo = parseRepoConfig(null);
    const plain = resolveConfig(inputs(base), repo);
    expect(plain).toMatchObject({ llmProvider: 'anthropic', anthropicApiKey: 'sk-test' });

    const bedrock = resolveConfig(inputs({ 'llm-provider': 'bedrock', 'aws-region': 'us-west-2' }), repo);
    expect(bedrock).toMatchObject({ llmProvider: 'bedrock', awsRegion: 'us-west-2', anthropicApiKey: '' });
    // A key left in the workflow is never sent anywhere on another platform.
    expect(resolveConfig(inputs({ ...base, 'llm-provider': 'bedrock' }), repo).anthropicApiKey).toBe('');

    const vertex = resolveConfig(inputs({ 'llm-provider': 'vertex', 'vertex-project-id': 'qa-proj' }), repo);
    expect(vertex).toMatchObject({
      llmProvider: 'vertex',
      vertexProjectId: 'qa-proj',
      vertexRegion: 'global',
    });
    expect(
      resolveConfig(inputs({ 'llm-provider': 'vertex', 'vertex-region': 'us-east5' }), repo).vertexRegion,
    ).toBe('us-east5');
  });

  it('v0.2 an unknown llm-provider is a config error; the key error says how to avoid the key', () => {
    const repo = parseRepoConfig(null);
    expect(() => resolveConfig(inputs({ ...base, 'llm-provider': 'azure' }), repo)).toThrow(/llm-provider/);
    expect(() => resolveConfig(inputs({}), repo)).toThrow(/bedrock or vertex/);
  });

  it('prefers slack bot mode over webhook and requires a channel', () => {
    const repo = parseRepoConfig(null);
    expect(
      resolveConfig(
        inputs({
          ...base,
          'slack-bot-token': 'xoxb',
          'slack-channel': 'C1',
          'slack-webhook-url': 'https://h',
        }),
        repo,
      ).slack,
    ).toEqual({ mode: 'bot', token: 'xoxb', channel: 'C1' });
    expect(resolveConfig(inputs({ ...base, 'slack-webhook-url': 'https://h' }), repo).slack).toEqual({
      mode: 'webhook',
      url: 'https://h',
    });
    expect(() => resolveConfig(inputs({ ...base, 'slack-bot-token': 'xoxb' }), repo)).toThrow(
      /slack-channel/,
    );
  });

  it('enables jira only with all three inputs and takes the AC field from the repo config', () => {
    const repo = parseRepoConfig(
      'prd:\n  jiraAcceptanceCriteriaField: customfield_1\n  jiraProjectKeys: [proj]\n',
    );
    const partial = resolveConfig(inputs({ ...base, 'jira-base-url': 'https://a.atlassian.net' }), repo);
    expect(partial.jira).toBeNull();
    const full = resolveConfig(
      inputs({
        ...base,
        'jira-base-url': 'https://a.atlassian.net/',
        'jira-email': 'e',
        'jira-api-token': 't',
      }),
      repo,
    );
    expect(full.jira).toEqual({
      baseUrl: 'https://a.atlassian.net',
      email: 'e',
      apiToken: 't',
      acceptanceCriteriaField: 'customfield_1',
    });
    expect(full.jiraProjectKeys).toEqual(['PROJ']);
  });

  it('lets action inputs override repo config project keys', () => {
    const repo = parseRepoConfig('prd:\n  jiraProjectKeys: [OLD]\n');
    expect(resolveConfig(inputs({ ...base, 'jira-project-keys': 'web, app' }), repo).jiraProjectKeys).toEqual(
      ['WEB', 'APP'],
    );
  });

  it.each([
    ['effort', 'extreme'],
    ['rerun-on-push', 'yes'],
    ['token-budget', '10'],
    ['max-cost-usd', '-1'],
    ['max-scenarios', '0'],
    ['fail-on', 'always'],
  ])('rejects invalid %s=%s', (name, value) => {
    expect(() => resolveConfig(inputs({ ...base, [name]: value }), parseRepoConfig(null))).toThrow(QtgError);
  });

  it('merges repo filters, scoring paths and prompt instructions', () => {
    const repo = parseRepoConfig(
      [
        'filters:',
        '  exclude: ["**/*.snap"]',
        '  include: ["db/migrations/**"]',
        'scoring:',
        '  boostPaths: ["src/domain/**"]',
        'prompt:',
        '  extraInstructions: amounts are integers',
        '  glossary:',
        '    - { term: settlement, meaning: payout batch }',
      ].join('\n'),
    );
    const cfg = resolveConfig(inputs(base), repo);
    expect(cfg.preprocess.exclude).toEqual(['**/*.snap']);
    expect(cfg.preprocess.include).toEqual(['db/migrations/**']);
    expect(cfg.preprocess.scoring.boostPaths).toEqual(['src/domain/**']);
    expect(cfg.repoInstructions.glossary).toEqual([{ term: 'settlement', meaning: 'payout batch' }]);
  });
});

describe('parseRepoConfig', () => {
  it('rejects invalid YAML and unknown keys', () => {
    expect(() => parseRepoConfig('filters: [')).toThrow(/YAML/);
    expect(() => parseRepoConfig('unknownKey: 1')).toThrow(/invalid/);
  });
});
