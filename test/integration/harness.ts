/**
 * End-to-end harness (SPEC §12.2): every real module wired exactly like src/adapters/wire.ts,
 * with fakes only at the HTTP / SDK edges. Owner: qa-work-session-a.
 *
 * - GitHub: Octokit with an injected fetch backed by a stateful in-memory repository.
 * - Jira: the real provider over undici's fetch + MockAgent. Notion: the real provider with fetch injection.
 * - Anthropic: the real provider with a fake `client` that records every request body.
 * - Slack: the real deliverer with a fake chat client. Summary: the real deliverer with an in-memory sink.
 */
import { readFileSync } from 'node:fs';
import { getOctokit } from '@actions/github';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { redactText } from '../../src/adapters/wire';
import { createGitHubReader } from '../../src/context/github';
import { createGitHubIssueProvider } from '../../src/context/prd/github-issue';
import { createJiraProvider } from '../../src/context/prd/jira';
import { createNotionProvider } from '../../src/context/prd/notion';
import { extractPrdRefs } from '../../src/context/prd/refs';
import { collectPrdDocuments } from '../../src/context/prd/registry';
import { type InputReader, parseRepoConfig, type QtgConfig, resolveConfig } from '../../src/core/config';
import type { PreprocessEngine, PullRequestInfo, QaReport, TriggerEvent } from '../../src/core/contracts';
import { astExtensionsFor } from '../../src/core/languages';
import { MAX_OUTPUT_TOKENS } from '../../src/core/limits';
import { type PipelineOutcome, runPipeline } from '../../src/core/pipeline';
import { createPrCommentStore } from '../../src/delivery/comment-store';
import { renderPrComment } from '../../src/delivery/render/markdown';
import { createSlackDeliverer, type SlackChatClient } from '../../src/delivery/slack';
import { createSummaryDeliverer } from '../../src/delivery/summary';
import type { AnthropicClientLike, LlmMessage, LlmStream } from '../../src/llm/anthropic';
import { createAnthropicProvider } from '../../src/llm/anthropic';
import { orchestrate } from '../../src/llm/orchestrate';
import { createPreprocessEngine, isNoisePath } from '../../src/preprocess';
import { fakeFetch, json, type RecordedRequest } from '../context/helpers';
import { fakeReport, inputs, silentLogger } from '../helpers/fakes';

const ROOT = new URL('../../', import.meta.url);
export const readFixture = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(`fixtures/${path}`, ROOT), 'utf8')) as T;

export interface PrFixture {
  repo: { owner: string; repo: string };
  pull: {
    number: number;
    title: string;
    body: string;
    labels: { name: string }[];
    base: { ref: string; sha: string; repo: { full_name: string } };
    head: { ref: string; sha: string; repo: { full_name: string } };
    [k: string]: unknown;
  };
  files: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
  headContents: Record<string, string>;
  repoConfig: string;
  issues: Record<string, Record<string, unknown>>;
}

export const SLACK_CHANNEL = 'C0123456789';
export const BOT = 'github-actions[bot]';
const JIRA_SITE = 'https://acme.atlassian.net';

/** One ordered log of every outward-facing side effect, across all fakes. */
export type LogEntry =
  | 'github:create-comment'
  | 'github:update-comment'
  | 'slack:post-parent'
  | 'slack:post-thread'
  | 'slack:update'
  | 'slack:delete'
  | 'summary:markdown'
  | 'summary:json'
  | 'anthropic:request';

export interface Comment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
}

/** A tiny GitHub: one PR whose head SHA, files and comments tests can change between runs. */
export class FakeGitHub {
  readonly pull: PrFixture['pull'];
  files: PrFixture['files'];
  readonly contents = new Map<string, string>();
  /** `${from}...${to}` → changed paths, for TRG-04. */
  readonly compare = new Map<string, string[]>();
  readonly comments: Comment[] = [];
  readonly requests: RecordedRequest[] = [];
  private nextId = 1000;

  constructor(
    readonly fx: PrFixture,
    private readonly log: LogEntry[],
  ) {
    this.pull = structuredClone(fx.pull);
    this.files = structuredClone(fx.files);
    for (const [path, text] of Object.entries(fx.headContents))
      this.contents.set(`${path}@${fx.pull.head.sha}`, text);
    this.contents.set(`.github/qa-ticket-generator.yml@${fx.pull.base.sha}`, fx.repoConfig);
  }

  /** Moves the PR head (a push) and copies head contents to the new SHA. */
  push(newSha: string, changedSinceLast: string[]): void {
    const old = this.pull.head.sha;
    for (const [key, text] of [...this.contents]) {
      if (key.endsWith(`@${old}`)) this.contents.set(key.replace(`@${old}`, `@${newSha}`), text);
    }
    this.compare.set(`${old}...${newSha}`, changedSinceLast);
    this.pull.head.sha = newSha;
  }

  addComment(login: string, body: string): Comment {
    const id = this.nextId++;
    const c: Comment = {
      id,
      body,
      user: { login },
      created_at: new Date(Date.UTC(2026, 10, 12, 0, 0, id - 1000)).toISOString(),
      html_url: `https://github.com/acme/shop/pull/42#issuecomment-${id}`,
    };
    this.comments.push(c);
    return c;
  }

  readonly handle = (req: RecordedRequest): Response => {
    this.requests.push(req);
    const { owner, repo } = this.fx.repo;
    const path = decodeURIComponent(req.url.pathname);
    const base = `/repos/${owner}/${repo}`;
    const n = this.pull.number;
    if (req.method === 'GET' && path === `${base}/pulls/${n}`) return json(this.pull);
    if (req.method === 'GET' && path === `${base}/pulls/${n}/files`) {
      const page = Number(req.url.searchParams.get('page') ?? '1');
      const per = Number(req.url.searchParams.get('per_page') ?? '30');
      const slice = this.files.slice((page - 1) * per, page * per);
      const more = page * per < this.files.length;
      return json(
        slice,
        200,
        more
          ? {
              link: `<https://api.github.com${base}/pulls/${n}/files?per_page=${per}&page=${page + 1}>; rel="next"`,
            }
          : {},
      );
    }
    const content = path.match(new RegExp(`^${base}/contents/(.+)$`));
    if (req.method === 'GET' && content?.[1]) {
      const text = this.contents.get(`${content[1]}@${req.url.searchParams.get('ref')}`);
      if (text === undefined) return json({ message: 'Not Found' }, 404);
      const buf = Buffer.from(text);
      return json({
        type: 'file',
        encoding: 'base64',
        size: buf.byteLength,
        content: buf.toString('base64'),
      });
    }
    const cmp = path.match(new RegExp(`^${base}/compare/(.+)$`));
    if (req.method === 'GET' && cmp?.[1]) {
      const files = this.compare.get(cmp[1]);
      return files
        ? json({ files: files.map((filename) => ({ filename })) })
        : json({ message: 'Not Found' }, 404);
    }
    // GITHUB_TOKEN cannot call GET /user → the comment store trusts github-actions[bot].
    if (path === '/user') return json({ message: 'Resource not accessible by integration' }, 403);
    if (req.method === 'GET' && path === `${base}/issues/${n}/comments`) return json(this.comments);
    if (req.method === 'POST' && path === `${base}/issues/${n}/comments`) {
      this.log.push('github:create-comment');
      const body = (JSON.parse(req.body ?? '{}') as { body: string }).body;
      return json(this.addComment(BOT, body), 201);
    }
    const edit = path.match(new RegExp(`^${base}/issues/comments/(\\d+)$`));
    if (req.method === 'PATCH' && edit?.[1]) {
      this.log.push('github:update-comment');
      const c = this.comments.find((x) => x.id === Number(edit[1]));
      if (!c) return json({ message: 'Not Found' }, 404);
      c.body = (JSON.parse(req.body ?? '{}') as { body: string }).body;
      return json(c);
    }
    const issue = path.match(new RegExp(`^${base}/issues/(\\d+)$`));
    if (req.method === 'GET' && issue?.[1] && this.fx.issues[issue[1]]) return json(this.fx.issues[issue[1]]);
    return json({ message: `unhandled ${req.method} ${path}` }, 404);
  };

  /** The one comment written by the bot (throws when there is not exactly one). */
  botComment(): Comment {
    const mine = this.comments.filter((c) => c.user.login === BOT);
    if (mine.length !== 1) throw new Error(`expected one bot comment, found ${mine.length}`);
    return mine[0] as Comment;
  }
}

/** Anthropic client fake: records request bodies and answers with a report. */
export class FakeAnthropic {
  readonly requests: { body: Record<string, unknown>; beta: boolean }[] = [];
  /** Decides the report for a request; defaults to `fakeReport()`. */
  respond: (body: Record<string, unknown>) => QaReport = () => fakeReport();

  constructor(private readonly log: LogEntry[]) {}

  private stream =
    (beta: boolean) =>
    (body: unknown): LlmStream => {
      const b = body as Record<string, unknown>;
      this.requests.push({ body: structuredClone(b), beta });
      this.log.push('anthropic:request');
      const listeners: (() => void)[] = [];
      return {
        on: (_event, listener) => {
          listeners.push(listener);
          return undefined;
        },
        finalMessage: async (): Promise<LlmMessage> => {
          for (const l of listeners) l();
          return {
            content: [{ type: 'text', text: JSON.stringify(this.respond(b)) }],
            stop_reason: 'end_turn',
            model: String(b.model),
            usage: {
              input_tokens: 2_000,
              output_tokens: 1_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          };
        },
      };
    };

  readonly client: AnthropicClientLike = {
    messages: { stream: this.stream(false) },
    beta: { messages: { stream: this.stream(true) } },
  };

  /** Text blocks of a request's user message: [prd, metadata, tail]. */
  static userBlocks(body: Record<string, unknown>): string[] {
    const messages = body.messages as { content: { text: string }[] }[];
    return (messages[0]?.content ?? []).map((c) => c.text);
  }
}

/** Slack chat fake with monotonically increasing timestamps (survives across runs). */
export class FakeSlack {
  readonly calls: { method: 'post' | 'update' | 'delete'; args: Record<string, unknown> }[] = [];
  private seq = 0;
  constructor(private readonly log: LogEntry[]) {}

  readonly client: SlackChatClient = {
    chat: {
      postMessage: async (args) => {
        this.seq += 1;
        const ts = `1700000000.${String(this.seq).padStart(6, '0')}`;
        this.calls.push({ method: 'post', args: { ...args, ts } });
        this.log.push(args.thread_ts ? 'slack:post-thread' : 'slack:post-parent');
        return { ok: true, channel: args.channel, ts };
      },
      update: async (args) => {
        this.calls.push({ method: 'update', args });
        this.log.push('slack:update');
        return { ok: true };
      },
      delete: async (args) => {
        this.calls.push({ method: 'delete', args });
        this.log.push('slack:delete');
        return { ok: true };
      },
    },
  };
}

/** Jira Cloud over undici MockAgent, serving one issue fixture. */
export function fakeJira(issues: Record<string, unknown>) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(JIRA_SITE);
  for (const [key, payload] of Object.entries(issues)) {
    pool
      .intercept({ path: (p) => p.startsWith(`/rest/api/3/issue/${key}?`), method: 'GET' })
      .reply(200, JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
      .persist();
  }
  const fetch = ((url: string, init: RequestInit) =>
    undiciFetch(url, { ...(init as object), dispatcher: agent })) as unknown as typeof globalThis.fetch;
  return { agent, fetch };
}

/** Notion API serving a `{ page, children }` fixture (as in fixtures/context/notion). */
export function fakeNotion(data: { page: Record<string, unknown>; children: Record<string, unknown[]> }) {
  return fakeFetch((req) => {
    const path = req.url.pathname;
    if (/^\/v1\/pages\//.test(path)) return json(data.page);
    const id = path.match(/^\/v1\/blocks\/([^/]+)\/children$/)?.[1] ?? '';
    const all = data.children[id] ?? data.children[id.replace(/-/g, '')] ?? [];
    return json({
      object: 'list',
      type: 'block',
      block: {},
      results: all,
      has_more: false,
      next_cursor: null,
    });
  });
}

export interface World {
  log: LogEntry[];
  github: FakeGitHub;
  anthropic: FakeAnthropic;
  slack: FakeSlack;
  jira: ReturnType<typeof fakeJira>;
  notion: ReturnType<typeof fakeNotion>;
  summaries: { markdown: string[]; json: string[] };
  logger: ReturnType<typeof silentLogger>;
}

export function createWorld(fx: PrFixture = readFixture<PrFixture>('integration/coupon-pr.json')): World {
  const log: LogEntry[] = [];
  return {
    log,
    github: new FakeGitHub(fx, log),
    anthropic: new FakeAnthropic(log),
    slack: new FakeSlack(log),
    jira: fakeJira({ 'PROJ-123': readFixture('context/jira/issue-coupon.json') }),
    notion: fakeNotion(readFixture('context/notion/page-coupon.json')),
    summaries: { markdown: [], json: [] },
    logger: silentLogger(),
  };
}

export const BASE_INPUTS: Record<string, string> = {
  'anthropic-api-key': 'sk-ant-test',
  'github-token': 'ghs-test',
  'slack-bot-token': 'xoxb-test',
  'slack-channel': SLACK_CHANNEL,
  'jira-base-url': JIRA_SITE,
  'jira-email': 'bot@example.invalid',
  'jira-api-token': 'jira-test',
  'notion-token': 'notion-test',
};

let enginePromise: Promise<PreprocessEngine> | undefined;
/** The real engine with real tree-sitter WASM grammars, loaded once per test file. */
export const engine = (): Promise<PreprocessEngine> =>
  (enginePromise ??= createPreprocessEngine({
    astLanguages: resolveConfig(inputs(BASE_INPUTS), parseRepoConfig(null)).preprocess.astLanguages,
  }));

export interface RunResult {
  outcome: PipelineOutcome;
  cfg: QtgConfig;
  pr: PullRequestInfo;
}

/**
 * One workflow run: resolves the config (repo file from the base SHA), reads the PR, builds
 * every module like the composition root and calls `runPipeline`.
 */
export async function runOnce(
  world: World,
  event: TriggerEvent,
  extraInputs: Record<string, string> = {},
): Promise<RunResult> {
  const input: InputReader = inputs({ ...BASE_INPUTS, ...extraInputs });
  const early = resolveConfig(input, parseRepoConfig(null));
  const { fetch } = fakeFetch(world.github.handle);
  const octokit = getOctokit('ghs-test', { request: { fetch } });
  const { owner, repo } = world.github.fx.repo;
  const instant = { sleep: async () => undefined };

  const reader = createGitHubReader(octokit, {
    owner,
    repo,
    astExtensions: astExtensionsFor(early.preprocess.astLanguages),
    logger: world.logger,
    retry: instant,
  });
  const pr = await reader.getPullRequest(world.github.pull.number);
  const cfg = resolveConfig(input, parseRepoConfig(await reader.getRepoConfigText(pr, early.configPath)));

  const llm = createAnthropicProvider(
    {
      apiKey: cfg.anthropicApiKey,
      model: cfg.model,
      effort: cfg.effort,
      serverFallback: cfg.serverFallback,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    { client: world.anthropic.client, logger: world.logger },
  );
  const summarySink = {
    writeMarkdown: async (md: string) => {
      world.log.push('summary:markdown');
      world.summaries.markdown.push(md);
    },
    writeJson: async (text: string) => {
      world.log.push('summary:json');
      world.summaries.json.push(text);
      return 'report.json';
    },
  };

  let t = 0;
  const outcome = await runPipeline(
    {
      logger: world.logger,
      github: reader,
      commentStore: createPrCommentStore(octokit, { logger: world.logger, retry: instant }),
      prdProviders: [
        createGitHubIssueProvider(octokit, { retry: instant }),
        createJiraProvider(cfg.jira, { fetch: world.jira.fetch, retry: instant }),
        createNotionProvider(cfg.notionToken, { fetch: world.notion.fetch }),
      ],
      extractPrdRefs,
      collectPrdDocuments,
      preprocessEngine: await engine(),
      isNoisePath,
      redactText,
      llm,
      orchestrate,
      renderPrComment,
      summary: createSummaryDeliverer(summarySink),
      slack: createSlackDeliverer(cfg.slack, world.logger, {
        client: world.slack.client,
        fullReportUrl: (final) => final.pr.htmlUrl,
      }),
      now: () => (t += 1_000),
    },
    cfg,
    pr,
    event,
    new AbortController().signal,
  );
  return { outcome, cfg, pr };
}

/** The webhook-shaped event for the current PR state. */
export function prEvent(world: World, action: 'labeled' | 'synchronize', addedLabel?: string): TriggerEvent {
  const p = world.github.pull;
  return {
    name: 'pull_request',
    action,
    ...(addedLabel ? { addedLabel } : {}),
    pr: { number: p.number, state: 'open', labels: p.labels.map((l) => l.name), isFork: false, draft: false },
  };
}

/** Hidden qtg-state of a comment body. */
export function stateOf(body: string): Record<string, unknown> {
  const m = [...body.matchAll(/<!-- qtg-state:(.*?) -->/gs)].at(-1);
  return m?.[1] ? (JSON.parse(m[1]) as Record<string, unknown>) : {};
}
