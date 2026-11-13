/**
 * Where new code-derived cases may come from after the first check of a pull request
 * (SPEC v3 §2.2): only from the lines pushed since the last check.
 *
 * `VerifyRequest.newCaseScope` carries those lines as compare patches, which core has already
 * redacted once (PRE-05). They are used as given: masking them again would relabel the markers
 * and double the counts. This module turns them into what the prompt may show and what the code
 * can check:
 *
 * - A patch is shown only for a file the model is also shown in <code_changes> with hunks. A
 *   file the preprocessor left out or reduced to a summary keeps its content to itself here too.
 * - A file whose changed lines are comments, blank lines or re-flowed whitespace cannot create a
 *   risk, so no new case can come from it.
 *
 * `inScope` is the deterministic check on what the model returns. It only drops a case it can
 * show to be outside the change; when it cannot tell, the case stays.
 * Owner: qa-work-session-c(fable).
 */
import type { CaseDraft, VerifyRequest } from '../core/cases';
import type { CodeChunk } from '../core/contracts';

export type ScopeKind =
  /** Lines that can change behavior. New cases may come from here. */
  | 'code'
  /** Only comments, blank lines or whitespace changed. */
  | 'cosmetic'
  /** Changed, but the model is not shown this file's code (skipped, or summary only). */
  | 'hidden';

export interface ScopeFile {
  path: string;
  kind: ScopeKind;
  /** The patch as core passed it (already redacted); empty for `hidden`. */
  patch: string;
  /**
   * What a case about this change may name: the patch, plus the functions and classes of the pull
   * request that enclose the changed lines (their names and text). Used by the check, never shown.
   */
  related: string;
}

export interface ResolvedScope {
  sinceSha: string;
  files: ScopeFile[];
}

const C_LIKE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'java',
  'kt',
  'kts',
  'go',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'rs',
  'php',
  'scala',
  'dart',
  'groovy',
  'css',
  'scss',
  'less',
]);
const HASH = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'pl', 'r', 'tf']);
const DASH = new Set(['sql', 'lua', 'hs']);
const MARKUP = new Set(['html', 'htm', 'xml', 'vue', 'svelte', 'md']);

const extension = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'dockerfile' || name === 'makefile') return 'sh';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
};

/** Whether a line holds nothing but a comment, in the comment syntax of this file's language. */
function isCommentLine(line: string, ext: string): boolean {
  if (C_LIKE.has(ext)) {
    // "* text" is a block-comment body; "*p = 1" (a dereference) is not.
    return /^(?:\/\/|\/\*|\*\/|\*$|\* )/.test(line);
  }
  if (HASH.has(ext)) return line.startsWith('#');
  if (DASH.has(ext)) return line.startsWith('--');
  if (MARKUP.has(ext)) return line.startsWith('<!--') && line.endsWith('-->');
  return false; // unknown language: assume code
}

/**
 * True when a patch changes nothing that runs: every added or removed line is blank or a comment,
 * or the added lines are the removed ones with different whitespace. When in doubt it is false.
 */
export function isCosmeticPatch(path: string, patch: string): boolean {
  const ext = extension(path);
  const added: string[] = [];
  const removed: string[] = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    const sign = raw[0];
    if (sign !== '+' && sign !== '-') continue;
    const line = raw.slice(1).trim();
    if (line === '' || isCommentLine(line, ext)) continue;
    (sign === '+' ? added : removed).push(line);
  }
  if (added.length === 0 && removed.length === 0) return true;
  // Re-flowed code: the same characters once whitespace is ignored.
  const squash = (lines: string[]): string => lines.join('').replace(/\s+/g, '');
  return squash(added) === squash(removed);
}

/** Line numbers in the new file that a patch adds, or at which it removes lines. */
export function changedLines(patch: string): number[] {
  const lines: number[] = [];
  let at = 0;
  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      at = Number(header[1]);
      continue;
    }
    if (at === 0 || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) lines.push(at++);
    else if (raw.startsWith('-')) lines.push(at);
    else at++;
  }
  return [...new Set(lines)];
}

/**
 * The scope as the verify phase uses it, or null when the whole pull request is in scope.
 * `chunks` are the chunks that will be judged; only their files with hunks can show a patch.
 */
export function resolveScope(
  scope: VerifyRequest['newCaseScope'],
  chunks: CodeChunk[],
): ResolvedScope | null {
  if (!scope) return null;
  const shown = new Map(
    chunks.flatMap((c) => c.files.filter((f) => f.hunks.length > 0).map((f) => [f.path, f] as const)),
  );
  const files = scope.changes.map((change): ScopeFile => {
    const file = shown.get(change.path);
    if (!file) return { path: change.path, kind: 'hidden', patch: '', related: '' };
    const patch = change.patch;
    const touched = changedLines(change.patch);
    const enclosing = file.contexts.filter((ctx) =>
      touched.some((n) => n >= ctx.startLine && n <= ctx.endLine),
    );
    return {
      path: change.path,
      kind: isCosmeticPatch(change.path, change.patch) ? 'cosmetic' : 'code',
      patch,
      related: [patch, ...enclosing.map((ctx) => `${ctx.name ?? ''}\n${ctx.text}`)].join('\n'),
    };
  });
  return { sinceSha: scope.sinceSha, files };
}

/** The files a new case may come from, optionally only those of one chunk. */
export function scopeCodeFiles(scope: ResolvedScope, chunk?: CodeChunk): ScopeFile[] {
  const inChunk = chunk ? new Set(chunk.files.map((f) => f.path)) : null;
  return scope.files.filter((f) => f.kind === 'code' && (!inChunk || inChunk.has(f.path)));
}

export type OutOfScopeReason =
  /** Nothing that changes behavior was pushed since the last check. */
  | 'no_behavior_change'
  /** The case names none of the files that changed. */
  | 'no_changed_file_named'
  /** The case names code (a function, a constant) that appears nowhere in the changed hunks. */
  | 'unchanged_code_named';

const WORD = '[A-Za-z0-9_$]';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, word: string): boolean =>
  new RegExp(`(?<!${WORD})${escapeRegExp(word)}(?!${WORD})`).test(text);
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Names in a sentence that are clearly code: camelCase, snake_case, CONSTANT_CASE, dotted members,
 * anything called with "(" and anything in backticks. Plain words are not taken, so a sentence
 * without such names yields nothing and cannot be judged by them.
 */
export function codeNames(text: string): string[] {
  const names = new Set<string>();
  const take = (token: string): void => {
    for (const part of token.split('.')) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]{2,}$/.test(part)) names.add(part);
    }
  };
  for (const m of text.matchAll(/`([^`]{1,80})`/g)) {
    for (const t of (m[1] as string).match(/[A-Za-z_$][A-Za-z0-9_$.]*/g) ?? []) take(t);
  }
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(\()?/g)) {
    const token = m[0].replace(/\($/, '');
    const looksLikeCode =
      m[1] === '(' || token.includes('.') || token.includes('_') || /[a-z0-9][A-Z]/.test(token);
    if (looksLikeCode) take(token);
  }
  return [...names];
}

/**
 * Whether a new case can have come from the change. Returns null when it can, or the reason it
 * cannot.
 *
 * 1. With no behavior-changing file in scope, no case can.
 * 2. The case has to name a changed file, by path or by file name, in any of its text. The prompt
 *    asks for the file in `whyEasyToMiss`; a case that names no changed file points elsewhere.
 * 3. If its `whyEasyToMiss` names code, at least one of those names has to appear in what the
 *    change touched in the files it names: the hunks (changed lines, their context, the hunk
 *    header) or the functions and classes that enclose the changed lines. A case that names no
 *    code passes on rule 2 alone.
 */
export function outOfScope(c: CaseDraft, scope: ResolvedScope): OutOfScopeReason | null {
  const eligible = scopeCodeFiles(scope);
  if (eligible.length === 0) return 'no_behavior_change';
  const text = [c.title, c.whyEasyToMiss, ...c.preconditions, ...c.testData, ...c.steps, ...c.expected].join(
    '\n',
  );
  const named = eligible.filter((f) => text.includes(f.path) || hasWord(text, basename(f.path)));
  if (named.length === 0) return 'no_changed_file_named';
  // Path parts are not code names: "src/coupon_rules.ts" must not count as naming coupon_rules.
  const pathWords = new Set(scope.files.flatMap((f) => f.path.split(/[/.]/)));
  const names = codeNames(c.whyEasyToMiss).filter((n) => !pathWords.has(n));
  if (names.length === 0) return null;
  const touched = named.map((f) => f.related).join('\n');
  return names.some((n) => hasWord(touched, n)) ? null : 'unchanged_code_named';
}
