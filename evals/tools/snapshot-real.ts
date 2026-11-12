/**
 * Real-PR snapshots for the eval set (SPEC §14 M3.5). Owner: qa-work-session-a.
 *
 * Reads `evals/real-sources.json` and, for each entry, fetches the PR through the action's own
 * modules (createGitHubReader, extractPrdRefs, createGitHubIssueProvider) and writes the case
 * format of evals/schema.ts to `evals/real/<id>/` (git-ignored):
 *   pr.json · files.json · prd/NN-github-<owner>-<repo>-<n>.json   (no expected.json)
 *
 * Source code is never committed: snapshots are re-created locally. Output is deterministic —
 * the same head SHA (and unchanged PR/issue text) gives byte-identical files.
 *
 * Only GitHub REST GET requests are made; anything else is refused before it leaves the process.
 *
 *   GITHUB_TOKEN="$(gh auth token)" node evals/cli.mjs snapshot-real [--ids real-zod-6662,...]
 *
 * This module has no top-level side effects: it only runs when evals/main.ts calls `main`, so
 * bundling it never starts GitHub requests for other commands.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOctokit } from '@actions/github';
import { z } from 'zod';
import { createGitHubReader } from '../../src/context/github';
import { createGitHubIssueProvider } from '../../src/context/prd/github-issue';
import { extractPrdRefs } from '../../src/context/prd/refs';
import { collectPrdDocuments } from '../../src/context/prd/registry';
import type { RetryOptions } from '../../src/context/retry';
import type { PrdDocument, Warning } from '../../src/core/contracts';
import { AST_LANGUAGE_EXTENSIONS, astExtensionsFor } from '../../src/core/languages';
import { PRD_TIMEOUT_MS } from '../../src/core/limits';
import type { Octokit } from '../../src/core/octokit';
import { ChangedFileSchema, PrdDocumentSchema, PullRequestSchema } from '../schema';

const SHA = /^[0-9a-f]{40}$/;
const PERMISSIVE = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'] as const;
/** PRD documents per case, same default as the action (`prd.maxDocuments`). */
const MAX_PRD_DOCUMENTS = 5;

export const RealSourceSchema = z
  .object({
    /** Directory name under evals/real/ and the id the harness looks up: `real-<repo>-<pr>`. */
    id: z.string().regex(/^real-[a-z0-9-]+-\d+$/),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    pr: z.number().int().positive(),
    /** Issue the PR closes (for people; the snapshot follows the PR body like the action does). */
    issue: z.number().int().positive(),
    mergeSha: z.string().regex(SHA),
    /** Pinned: the snapshot fails when the PR's head is not this commit. */
    headSha: z.string().regex(SHA),
    changedFiles: z.number().int().min(1),
    license: z.enum(PERMISSIVE),
    language: z.enum(['TypeScript', 'Python', 'Go', 'Java']),
    domain: z.string().min(1),
    split: z.enum(['dev', 'test']),
    reason: z.string().min(20),
  })
  .strict();

export type RealSource = z.infer<typeof RealSourceSchema>;

export const RealSourcesSchema = z
  .array(RealSourceSchema)
  .min(1)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const [i, s] of list.entries()) {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', message: `duplicate id ${s.id}`, path: [i, 'id'] });
      seen.add(s.id);
      if (!s.id.endsWith(`-${s.pr}`)) {
        ctx.addIssue({ code: 'custom', message: `id ${s.id} must end with -${s.pr}`, path: [i, 'id'] });
      }
    }
  });

/** Deterministic JSON: our modules build objects in a fixed key order. */
export const toJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** `01-github-owner-repo-12.json`: the NN prefix keeps PR-body order under loadCase's name sort. */
export function prdFileName(index: number, doc: PrdDocument): string {
  const slug = `${doc.ref.source}-${doc.ref.id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${String(index + 1).padStart(2, '0')}-${slug}.json`;
}

export interface SnapshotResult {
  /** Path relative to the case directory → file content. */
  files: Map<string, string>;
  warnings: Warning[];
}

/**
 * Fetches one PR exactly the way the action does and renders the case files. Throws when the PR
 * head moved away from `source.headSha` or when an output would not load in the eval harness.
 */
export async function snapshotCase(
  source: RealSource,
  octokit: Octokit,
  options: { signal?: AbortSignal; retry?: RetryOptions } = {},
): Promise<SnapshotResult> {
  const [owner = '', repo = ''] = source.repo.split('/');
  const reader = createGitHubReader(octokit, {
    owner,
    repo,
    astExtensions: astExtensionsFor(Object.keys(AST_LANGUAGE_EXTENSIONS)),
    ...(options.retry ? { retry: options.retry } : {}),
  });

  const pr = await reader.getPullRequest(source.pr);
  if (pr.headSha !== source.headSha) {
    throw new Error(
      `${source.id}: head is ${pr.headSha.slice(0, 12)} but real-sources.json pins ${source.headSha.slice(0, 12)}; refusing to write a different snapshot.`,
    );
  }
  const changed = await reader.listChangedFiles(pr);

  const refs = extractPrdRefs(pr.body, {
    defaultOwner: owner,
    defaultRepo: repo,
    jiraProjectKeys: [],
    maxDocuments: MAX_PRD_DOCUMENTS,
  });
  const prd = await collectPrdDocuments(
    refs,
    [createGitHubIssueProvider(octokit, options.retry ? { retry: options.retry } : {})],
    {
      timeoutMs: PRD_TIMEOUT_MS,
      signal: options.signal ?? new AbortController().signal,
    },
  );

  // Validate against the harness schemas so a snapshot that would not load is never written.
  const files = new Map<string, string>();
  files.set('pr.json', toJson(PullRequestSchema.parse(pr)));
  files.set('files.json', toJson(z.array(ChangedFileSchema).min(1).parse(changed)));
  prd.documents.forEach((doc, i) => {
    files.set(`prd/${prdFileName(i, doc)}`, toJson(PrdDocumentSchema.parse(doc)));
  });
  return { files, warnings: prd.warnings };
}

/** Replaces `root/<id>/` with exactly `files` (stale PRD files from an earlier run are removed). */
export function writeSnapshot(root: string, id: string, files: Map<string, string>): string {
  const dir = join(root, id);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/**
 * `fetch` that only lets GitHub REST GET requests through and counts them. The approval for this
 * tool covers read-only calls to public repositories, so anything else fails locally.
 */
export function readOnlyFetch(base: typeof fetch = globalThis.fetch) {
  let count = 0;
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (method !== 'GET')
      throw new Error(`snapshot-real: refusing ${method} ${url.pathname} (read-only tool)`);
    if (url.hostname !== 'api.github.com')
      throw new Error(`snapshot-real: refusing request to ${url.hostname}`);
    count += 1;
    return base(input, init);
  };
  return { fetch: guarded as typeof fetch, calls: () => count };
}

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  print: (line: string) => void;
  root: string;
  sourcesPath: string;
  fetch?: typeof fetch;
}

/** CLI: snapshots every source (or `--ids a,b`) and prints the number of API calls. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const token = deps.env.GITHUB_TOKEN ?? deps.env.GH_TOKEN;
  if (!token) {
    deps.print(
      'Set GITHUB_TOKEN, e.g. GITHUB_TOKEN="$(gh auth token)". The token is only used for GET requests.',
    );
    return 2;
  }
  const idsFlag = argv.indexOf('--ids');
  const wanted = idsFlag >= 0 ? (argv[idsFlag + 1] ?? '').split(',').filter(Boolean) : [];
  const sources = RealSourcesSchema.parse(JSON.parse(readFileSync(deps.sourcesPath, 'utf8')));
  const unknown = wanted.filter((id) => !sources.some((s) => s.id === id));
  if (unknown.length > 0) {
    deps.print(`Unknown id(s): ${unknown.join(', ')}`);
    return 2;
  }
  const selected = wanted.length > 0 ? sources.filter((s) => wanted.includes(s.id)) : sources;

  const guard = readOnlyFetch(deps.fetch);
  const octokit = getOctokit(token, { request: { fetch: guard.fetch } });
  let failed = 0;
  for (const source of selected) {
    try {
      const { files, warnings } = await snapshotCase(source, octokit);
      writeSnapshot(deps.root, source.id, files);
      const prdCount = [...files.keys()].filter((k) => k.startsWith('prd/')).length;
      deps.print(`${source.id}: ${files.size} file(s) written, ${prdCount} PRD document(s)`);
      for (const w of warnings) deps.print(`  warning ${w.code}: ${w.message}`);
    } catch (err) {
      failed += 1;
      deps.print(`${source.id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  deps.print(`GitHub API calls (GET): ${guard.calls()}`);
  return failed > 0 ? 1 : 0;
}
