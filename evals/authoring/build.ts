/**
 * Case authoring helpers. A case is written once, as a TypeScript object (one file per case in
 * this directory), and compiled into the JSON files under `evals/cases/<id>/`. Changed files are
 * authored as a full-context annotated diff, so the unified patch and the head content always
 * agree with each other. Regenerate with `node evals/cli.mjs build-cases`.
 * Owner: qa-work-session-c(fable).
 */
import { createHash } from 'node:crypto';
import type { ChangedFile, PrdDocument, PrdSource, PullRequestInfo } from '../../src/core/contracts';
import type { Expected } from '../schema';

export interface AuthoredFile {
  path: string;
  /**
   * The whole file as an annotated diff: each line starts with `+` (added), `-` (removed) or a
   * space (unchanged). A completely empty line counts as an unchanged empty line.
   */
  diff?: string;
  /** For a new file: its content. Shorthand for a diff where every line is added. */
  content?: string;
  previousPath?: string;
  /** For files the API returns without a patch (binary, too large). */
  patchMissing?: { additions: number; deletions: number };
}

export interface AuthoredPrd {
  source: PrdSource;
  id: string;
  url: string;
  title: string;
  acceptanceCriteria: string[];
  body: string;
}

export interface AuthoredCase {
  id: string;
  pr: { number: number; title: string; author: string; headRef: string; body: string };
  prd: AuthoredPrd[];
  files: AuthoredFile[];
  expected: Expected;
}

export interface BuiltCase {
  id: string;
  pr: PullRequestInfo;
  files: ChangedFile[];
  prd: { name: string; doc: PrdDocument }[];
  expected: Expected;
}

type Tag = '+' | '-' | ' ';
interface Line {
  tag: Tag;
  text: string;
}

const CONTEXT = 3;
const OWNER = 'acme';
const REPO = 'shop';
const sha = (seed: string): string => createHash('sha1').update(seed).digest('hex');
const trimEdges = (text: string): string => text.replace(/^\n/, '').replace(/\n[ \t]*$/, '');

export function parseAnnotated(diff: string, path = '(diff)'): Line[] {
  return trimEdges(diff)
    .split('\n')
    .map((raw, i) => {
      if (raw === '') return { tag: ' ' as Tag, text: '' };
      const tag = raw[0];
      if (tag !== '+' && tag !== '-' && tag !== ' ') {
        throw new Error(`${path}: line ${i + 1} must start with "+", "-" or a space: ${JSON.stringify(raw)}`);
      }
      return { tag, text: raw.slice(1) };
    });
}

/** Renders a GitHub-style patch (hunks only, three lines of context) from annotated lines. */
export function renderPatch(lines: Line[]): string {
  const changed = lines.flatMap((l, i) => (l.tag === ' ' ? [] : [i]));
  if (changed.length === 0) return '';
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(lines.length - 1, i + CONTEXT);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const hunks = ranges.map(([start, end]) => {
    const before = lines.slice(0, start);
    const body = lines.slice(start, end + 1);
    const oldLen = body.filter((l) => l.tag !== '+').length;
    const newLen = body.filter((l) => l.tag !== '-').length;
    const oldBefore = before.filter((l) => l.tag !== '+').length;
    const newBefore = before.filter((l) => l.tag !== '-').length;
    const oldStart = oldLen === 0 ? oldBefore : oldBefore + 1;
    const newStart = newLen === 0 ? newBefore : newBefore + 1;
    return [
      `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`,
      ...body.map((l) => `${l.tag}${l.text}`),
    ].join('\n');
  });
  return hunks.join('\n');
}

function buildFile(file: AuthoredFile): ChangedFile {
  if (file.patchMissing) {
    return { path: file.path, status: 'modified', ...file.patchMissing, patchMissing: true };
  }
  const lines =
    file.content !== undefined
      ? trimEdges(file.content)
          .split('\n')
          .map((text) => ({ tag: '+' as Tag, text }))
      : parseAnnotated(file.diff ?? '', file.path);
  const additions = lines.filter((l) => l.tag === '+').length;
  const deletions = lines.filter((l) => l.tag === '-').length;
  if (additions + deletions === 0) throw new Error(`${file.path}: the diff changes nothing`);
  const head = lines.filter((l) => l.tag !== '-');
  const status =
    head.length === 0
      ? 'removed'
      : file.previousPath
        ? 'renamed'
        : deletions === 0 && head.length === additions
          ? 'added'
          : 'modified';
  return {
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    status,
    additions,
    deletions,
    patch: renderPatch(lines),
    patchMissing: false,
    ...(head.length > 0 ? { headContent: `${head.map((l) => l.text).join('\n')}\n` } : {}),
  };
}

/** Compiles an authored case into the objects stored as JSON. Deterministic. */
export function buildCase(def: AuthoredCase): BuiltCase {
  const pr: PullRequestInfo = {
    owner: OWNER,
    repo: REPO,
    number: def.pr.number,
    title: def.pr.title,
    body: trimEdges(def.pr.body),
    author: def.pr.author,
    htmlUrl: `https://github.com/${OWNER}/${REPO}/pull/${def.pr.number}`,
    baseRef: 'main',
    baseSha: sha(`${def.id}:base`),
    headRef: def.pr.headRef,
    headSha: sha(`${def.id}:head`),
    headRepoFullName: `${OWNER}/${REPO}`,
    isFork: false,
    draft: false,
    labels: ['needs-ai-qa'],
  };
  const prd = def.prd.map((p) => ({
    name: p.id.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    doc: {
      ref: { source: p.source, id: p.id, url: p.url, raw: p.id },
      title: p.title,
      bodyMarkdown: trimEdges(p.body),
      acceptanceCriteria: p.acceptanceCriteria,
      url: p.url,
      meta: {},
    } satisfies PrdDocument,
  }));
  return { id: def.id, pr, files: def.files.map(buildFile), prd, expected: def.expected };
}
