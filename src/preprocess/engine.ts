/**
 * The synchronous, deterministic, I/O-free preprocessing run (PRE-01). Stage order follows
 * SPEC §5.4 figure 1: filter → parse → redact → AST → score → pack.
 */
import type {
  ChangedFile,
  CodeChunk,
  CodeContext,
  Hunk,
  PackedFile,
  PrdDocument,
  PreprocessInput,
  PreprocessOutput,
  RedactionCount,
  SkippedFile,
} from '../core/contracts';
import { expandContexts } from './ast/expand';
import { languageForPath } from './ast/languages';
import type { AstRuntime } from './ast/runtime';
import { parsePatch, sideLines } from './diff';
import { manifestKind, summarizeManifest } from './manifest';
import {
  classifyPath,
  firstLines,
  GENERATED_HEADER_LINES,
  hasGeneratedHeader,
  isBinaryPath,
  isIncluded,
} from './noise';
import { pack, sized, type UnsizedFile } from './pack';
import { finalizeRedactions, redactDiffBody, redactText } from './redact';
import { changedText, prdKeywords, scoreFile } from './score';
import { allocatePrdBudget, codeBudget, prdBudget, prdDocumentTokens, truncatePrdDocument } from './tokens';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Classified = { skip: SkippedFile } | { file: ChangedFile; hunks: Hunk[] };

function noDiffSummary(file: ChangedFile): string {
  if (file.status === 'renamed' && file.previousPath) {
    return `renamed from ${file.previousPath} without content changes`;
  }
  if (file.status === 'added') return 'added an empty file';
  if (file.status === 'removed') return 'removed an empty file';
  return `no textual changes (${file.status})`;
}

/** PRE-02/04 — noise filter and diff parsing for one file. */
function classify(file: ChangedFile, input: PreprocessInput): Classified {
  const { options } = input;
  const verdict = classifyPath(file.path, options);
  if (verdict) return { skip: { path: file.path, reason: verdict.reason } };

  const parsed = file.patch ? parsePatch(file.patch) : null;
  if (parsed?.binary) return { skip: { path: file.path, reason: 'binary' } };
  const hunks = parsed?.hunks ?? [];
  if (hunks.length === 0 && (file.patchMissing || file.additions + file.deletions > 0)) {
    return { skip: { path: file.path, reason: isBinaryPath(file.path) ? 'binary' : 'patch_missing' } };
  }

  if (!isIncluded(file.path, options) && isGenerated(file, hunks)) {
    return { skip: { path: file.path, reason: 'noise' } };
  }
  return { file, hunks };
}

/** PRE-02 — `@generated` / `DO NOT EDIT` in the first lines (head content or a hunk at line 1). */
function isGenerated(file: ChangedFile, hunks: readonly Hunk[]): boolean {
  if (
    file.headContent !== undefined &&
    hasGeneratedHeader(firstLines(file.headContent, GENERATED_HEADER_LINES))
  ) {
    return true;
  }
  const first = hunks[0];
  if (!first) return false;
  if (first.newStart <= 1 && first.newLines > 0 && hasGeneratedHeader(sideLines(first, 'new'))) return true;
  return file.status === 'removed' && first.oldStart <= 1 && hasGeneratedHeader(sideLines(first, 'old'));
}

function redactHunk(h: Hunk): Hunk {
  return { ...h, header: redactText(h.header), text: redactDiffBody(h.text) };
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.endsWith('\r')) lines[i] = l.slice(0, -1);
  }
  return lines;
}

/** PRE-06 — symbol contexts from the head contents (modified / renamed files only). */
function contextsFor(
  file: ChangedFile,
  hunks: readonly Hunk[],
  input: PreprocessInput,
  ast: AstRuntime,
): CodeContext[] {
  if (file.headContent === undefined || file.headContent === '') return [];
  // Added files are fully visible in their diff; removed files have no head contents.
  if (file.status === 'added' || file.status === 'removed') return [];
  const language = languageForPath(file.path);
  const enabled = language !== null && input.options.astLanguages.includes(language);
  const parser = enabled ? (ast.parsers.get(language) ?? null) : null;
  const redactedLines = splitLines(redactText(file.headContent));
  return expandContexts({
    rawContent: file.headContent,
    redactedLines,
    hunks,
    language: parser ? language : null,
    parser,
  }).contexts;
}

function redactPrd(doc: PrdDocument): PrdDocument {
  const meta: Record<string, string> = {};
  for (const key of Object.keys(doc.meta).sort(cmp)) meta[key] = redactText(doc.meta[key] as string);
  return {
    ...doc,
    title: redactText(doc.title),
    bodyMarkdown: redactText(doc.bodyMarkdown),
    acceptanceCriteria: doc.acceptanceCriteria.map(redactText),
    meta,
  };
}

function finalizePrd(doc: PrdDocument, counts: Map<string, number>): PrdDocument {
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.meta)) meta[k] = finalizeRedactions(v, counts);
  return {
    ...doc,
    title: finalizeRedactions(doc.title, counts),
    bodyMarkdown: finalizeRedactions(doc.bodyMarkdown, counts),
    acceptanceCriteria: doc.acceptanceCriteria.map((a) => finalizeRedactions(a, counts)),
    meta,
  };
}

function finalizeFile(f: PackedFile, counts: Map<string, number>): PackedFile {
  const out: PackedFile = {
    path: f.path,
    ...(f.previousPath !== undefined ? { previousPath: f.previousPath } : {}),
    status: f.status,
    score: f.score,
    hunks: f.hunks.map((h) => ({
      header: finalizeRedactions(h.header, counts),
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      text: finalizeRedactions(h.text, counts),
    })),
    contexts: f.contexts.map((c) => ({
      kind: c.kind,
      ...(c.name !== undefined ? { name: c.name } : {}),
      startLine: c.startLine,
      endLine: c.endLine,
      text: finalizeRedactions(c.text, counts),
    })),
    ...(f.summary !== undefined ? { summary: finalizeRedactions(f.summary, counts) } : {}),
    estimatedTokens: f.estimatedTokens,
  };
  return out;
}

/** Runs the whole pipeline. Pure: same input → same output, no I/O. */
export function runPreprocess(input: PreprocessInput, ast: AstRuntime): PreprocessOutput {
  const { options } = input;
  const skipped: SkippedFile[] = [];

  // PRD first: keywords feed the file score, and its size feeds the code budget.
  const redactedDocs = input.prdDocuments.map(redactPrd);
  const keywords = prdKeywords(redactedDocs);
  const allowances = allocatePrdBudget(redactedDocs.map(prdDocumentTokens), prdBudget(options.tokenBudget));
  const docs = redactedDocs.map((d, i) => truncatePrdDocument(d, allowances[i] as number));
  const prdTokens = docs.reduce((s, d) => s + prdDocumentTokens(d), 0);

  const packed: PackedFile[] = [];
  for (const file of input.files) {
    const c = classify(file, input);
    if ('skip' in c) {
      skipped.push(c.skip);
      continue;
    }
    const hunks = c.hunks.map(redactHunk);
    const kind = manifestKind(file.path);
    const changedLines = file.additions + file.deletions;
    const base: UnsizedFile = {
      path: file.path,
      ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
      status: file.status,
      score: scoreFile(
        { path: file.path, previousPath: file.previousPath, changedLines, changedText: changedText(hunks) },
        keywords,
        options.scoring,
      ).score,
      hunks: kind ? [] : hunks,
      contexts: kind ? [] : contextsFor(file, hunks, input, ast),
    };
    if (kind) base.summary = summarizeManifest(kind, file.path, hunks);
    else if (hunks.length === 0) base.summary = noDiffSummary(file);
    packed.push(sized(base));
  }

  const budget = codeBudget(options.tokenBudget, options.reservedTokens, prdTokens);
  const result = pack(packed, budget);
  for (const path of result.tooLarge) skipped.push({ path, reason: 'too_large' });

  const counts = new Map<string, number>();
  const chunks: CodeChunk[] = result.chunks.map((ch) => ({
    id: ch.id,
    files: ch.files.map((f) => finalizeFile(f, counts)),
    estimatedTokens: ch.estimatedTokens,
  }));
  const prdDocuments = docs.map((d) => finalizePrd(d, counts));
  const redactions: RedactionCount[] = [...counts.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([type, count]) => ({ type, count }));
  skipped.sort((a, b) => cmp(a.path, b.path) || cmp(a.reason, b.reason));

  const perCall = options.reservedTokens + prdTokens;
  const estimatedTokens = chunks.reduce((s, ch) => s + perCall + ch.estimatedTokens, 0);
  return { mode: result.mode, chunks, prdDocuments, skipped, redactions, estimatedTokens };
}
