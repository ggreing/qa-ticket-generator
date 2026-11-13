/**
 * Config resolution (SPEC §4.2/§4.3): action inputs > repo config file > defaults.
 * OWNERSHIP: control session only.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Effort, Language, PreprocessOptions } from './contracts';
import { QtgError } from './errors';
import { type RepoConfig, RepoConfigSchema } from './schema';

export const DEFAULTS = {
  model: 'claude-opus-5-5',
  effort: 'high' as Effort,
  language: 'en' as Language,
  triggerLabel: 'needs-ai-qa',
  tokenBudget: 150_000,
  maxCostUsd: 2.0,
  maxScenarios: 8,
  maxPrdDocuments: 5,
  maxCases: 80,
  planLabel: 'needs-qa-plan',
  sinks: ['github-issue', 'file'] as string[],
  jiraSubtaskType: 'Sub-task',
  configPath: '.github/qa-ticket-generator.yml',
  astLanguages: ['typescript', 'tsx', 'javascript', 'python', 'java', 'go'],
  scoring: { prdKeyword: 3, changeSize: 1, domainPath: 2, testOrConfigPenalty: 2 },
  reservedTokens: 6_000,
} as const;

const LANGUAGE_ALIASES: Record<string, Language> = {
  en: 'en',
  ko: 'ko',
  kr: 'ko',
  ja: 'ja',
  jp: 'ja',
  'zh-cn': 'zh-CN',
  zh: 'zh-CN',
  cn: 'zh-CN',
  'zh-hans': 'zh-CN',
};

/** D-16 — accepts BCP 47 codes and common aliases (kr, jp, cn, zh), case-insensitive. */
export function normalizeLanguage(value: string): Language {
  const lang = LANGUAGE_ALIASES[value.trim().toLowerCase().replace('_', '-')];
  if (!lang) {
    throw new QtgError('config_invalid', `Unsupported language "${value}". Use one of: en, ko, ja, zh-CN.`);
  }
  return lang;
}

/** Fully resolved runtime configuration. */
export interface QtgConfig {
  anthropicApiKey: string;
  githubToken: string;
  model: string;
  effort: Effort;
  language: Language;
  triggerLabel: string;
  rerunOnPush: boolean;
  requirePrd: boolean;
  tokenBudget: number;
  maxCostUsd: number;
  maxScenarios: number;
  prComment: boolean;
  /** DLV-01 — trusted author of the marker comment; empty = auto-detect from the token. */
  commentAuthor: string | null;
  slack: { mode: 'bot'; token: string; channel: string } | { mode: 'webhook'; url: string } | { mode: 'off' };
  jira: { baseUrl: string; email: string; apiToken: string; acceptanceCriteriaField?: string } | null;
  jiraProjectKeys: string[];
  notionToken: string | null;
  configPath: string;
  failOn: 'none' | 'partial' | 'misaligned';
  failOnError: boolean;
  allowForkPrs: boolean;
  dryRun: boolean;
  serverFallback: boolean;
  maxPrdDocuments: number;
  /** SPEC v3 §7 */
  mode: 'auto' | 'plan' | 'verify';
  spec: string | null;
  planLabel: string;
  sinks: ('jira' | 'github-issue' | 'notion' | 'file')[];
  notionQaDatabaseId: string | null;
  jiraSubtaskType: string;
  maxCases: number;
  /** SPEC v3 §4 — plan even when the spec text has not changed since the last plan. */
  forcePlan: boolean;
  /** SPEC v3 §5 — `qa-cases.json` of an earlier run; the file sink continues from it. */
  previousCases: string | null;
  preprocess: PreprocessOptions;
  repoInstructions: {
    extraInstructions?: string;
    glossary?: { term: string; meaning: string }[];
    styleExamples?: string[];
  };
}

/** Reads one raw input; returns '' when unset (same contract as @actions/core getInput). */
export type InputReader = (name: string) => string;

const bool = (raw: string, name: string, fallback: boolean): boolean => {
  if (raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new QtgError('config_invalid', `Input "${name}" must be true or false.`);
};

const num = (raw: string, name: string, fallback: number, min: number, max: number): number => {
  if (raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new QtgError('config_invalid', `Input "${name}" must be a number between ${min} and ${max}.`);
  }
  return n;
};

const oneOf = <T extends string>(raw: string, name: string, values: readonly T[], fallback: T): T => {
  if (raw.trim() === '') return fallback;
  const v = raw.trim() as T;
  if (!values.includes(v)) {
    throw new QtgError('config_invalid', `Input "${name}" must be one of: ${values.join(', ')}.`);
  }
  return v;
};

const list = (raw: string): string[] =>
  raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Parses the repo config YAML (CTX-04 reads it from the BASE sha). Empty/null → defaults. */
export function parseRepoConfig(text: string | null): RepoConfig {
  if (!text || text.trim() === '') return RepoConfigSchema.parse({});
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new QtgError('config_invalid', 'Repo config file is not valid YAML.', { cause: err });
  }
  const result = RepoConfigSchema.safeParse(data ?? {});
  if (!result.success) {
    throw new QtgError('config_invalid', `Repo config file is invalid: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Resolves inputs + repo config into QtgConfig. Throws QtgError('config_invalid') on bad values. */
export function resolveConfig(input: InputReader, repo: RepoConfig): QtgConfig {
  const anthropicApiKey = input('anthropic-api-key').trim();
  // Required even for dry-run: dry-run still generates the report, it only skips publishing.
  if (!anthropicApiKey) {
    throw new QtgError('config_invalid', 'Input "anthropic-api-key" is required.');
  }

  const slackToken = input('slack-bot-token').trim();
  const slackChannel = input('slack-channel').trim();
  const slackWebhook = input('slack-webhook-url').trim();
  let slack: QtgConfig['slack'] = { mode: 'off' };
  if (slackToken) {
    if (!slackChannel)
      throw new QtgError('config_invalid', 'Input "slack-channel" is required with "slack-bot-token".');
    slack = { mode: 'bot', token: slackToken, channel: slackChannel };
  } else if (slackWebhook) {
    slack = { mode: 'webhook', url: slackWebhook };
  }

  const jiraBaseUrl = input('jira-base-url').trim().replace(/\/+$/, '');
  const jiraEmail = input('jira-email').trim();
  const jiraToken = input('jira-api-token').trim();
  const jira =
    jiraBaseUrl && jiraEmail && jiraToken
      ? {
          baseUrl: jiraBaseUrl,
          email: jiraEmail,
          apiToken: jiraToken,
          acceptanceCriteriaField: repo.prd.jiraAcceptanceCriteriaField,
        }
      : null;

  const inputKeys = list(input('jira-project-keys'));
  const languageRaw = input('language');

  return {
    anthropicApiKey,
    githubToken: input('github-token').trim(),
    model: input('model').trim() || DEFAULTS.model,
    effort: oneOf(
      input('effort'),
      'effort',
      ['low', 'medium', 'high', 'xhigh', 'max'] as const,
      DEFAULTS.effort,
    ),
    language: languageRaw.trim() ? normalizeLanguage(languageRaw) : DEFAULTS.language,
    triggerLabel: input('trigger-label').trim() || DEFAULTS.triggerLabel,
    rerunOnPush: bool(input('rerun-on-push'), 'rerun-on-push', true),
    requirePrd: bool(input('require-prd'), 'require-prd', false),
    tokenBudget: num(input('token-budget'), 'token-budget', DEFAULTS.tokenBudget, 20_000, 900_000),
    maxCostUsd: num(input('max-cost-usd'), 'max-cost-usd', DEFAULTS.maxCostUsd, 0.01, 100),
    maxScenarios: num(input('max-scenarios'), 'max-scenarios', DEFAULTS.maxScenarios, 1, 50),
    prComment: bool(input('pr-comment'), 'pr-comment', true),
    commentAuthor: input('comment-author').trim() || null,
    slack,
    jira,
    jiraProjectKeys: (inputKeys.length ? inputKeys : (repo.prd.jiraProjectKeys ?? [])).map((k) =>
      k.toUpperCase(),
    ),
    notionToken: input('notion-token').trim() || null,
    configPath: input('config-path').trim() || DEFAULTS.configPath,
    failOn: oneOf(input('fail-on'), 'fail-on', ['none', 'partial', 'misaligned'] as const, 'none'),
    failOnError: bool(input('fail-on-error'), 'fail-on-error', false),
    allowForkPrs: bool(input('allow-fork-prs'), 'allow-fork-prs', false),
    dryRun: bool(input('dry-run'), 'dry-run', false),
    forcePlan: bool(input('force-plan'), 'force-plan', false),
    serverFallback: bool(input('server-fallback'), 'server-fallback', true),
    maxPrdDocuments: repo.prd.maxDocuments ?? DEFAULTS.maxPrdDocuments,
    mode: oneOf(input('mode'), 'mode', ['auto', 'plan', 'verify'] as const, 'auto'),
    spec: input('spec').trim() || null,
    planLabel: input('plan-label').trim() || DEFAULTS.planLabel,
    sinks: parseSinks(input('sinks')),
    notionQaDatabaseId: input('notion-qa-database-id').trim() || null,
    jiraSubtaskType: input('jira-subtask-type').trim() || DEFAULTS.jiraSubtaskType,
    maxCases: num(input('max-cases'), 'max-cases', DEFAULTS.maxCases, 1, 300),
    previousCases: input('previous-cases').trim() || null,
    preprocess: {
      tokenBudget: num(input('token-budget'), 'token-budget', DEFAULTS.tokenBudget, 20_000, 900_000),
      exclude: repo.filters.exclude ?? [],
      include: repo.filters.include ?? [],
      scoring: {
        ...DEFAULTS.scoring,
        boostPaths: repo.scoring.boostPaths ?? [],
        penalizePaths: repo.scoring.penalizePaths ?? [],
      },
      astLanguages: [...DEFAULTS.astLanguages],
      reservedTokens: DEFAULTS.reservedTokens,
    },
    repoInstructions: {
      extraInstructions: repo.prompt.extraInstructions,
      glossary: repo.prompt.glossary,
      styleExamples: repo.prompt.styleExamples,
    },
  };
}

const SINKS = ['jira', 'github-issue', 'notion', 'file'] as const;

/** SPEC v3 §5 — comma list of sinks; unknown names are a config error. */
export function parseSinks(raw: string): QtgConfig['sinks'] {
  const names = list(raw);
  if (names.length === 0) return [...DEFAULTS.sinks] as QtgConfig['sinks'];
  for (const n of names) {
    if (!(SINKS as readonly string[]).includes(n)) {
      throw new QtgError('config_invalid', `Unknown sink "${n}". Use: ${SINKS.join(', ')}.`);
    }
  }
  return [...new Set(names)] as QtgConfig['sinks'];
}
