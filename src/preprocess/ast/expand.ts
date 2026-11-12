/**
 * Code context expansion (PRE-06): for every changed line, the nearest enclosing
 * function / method / class from the head file contents.
 *
 * - Symbols up to {@link MAX_SYMBOL_LINES} lines are included whole.
 * - Larger symbols keep the signature plus ±{@link WINDOW_LINES} lines around each change.
 * - Changes outside any symbol, unsupported languages and parse failures fall back to
 *   ±{@link WINDOW_LINES} line windows (`kind: 'lines'`).
 * - Contexts fully covered by a hunk (the hunk already shows that code) or by another full
 *   context are dropped.
 *
 * Synchronous and deterministic; the parser comes from the engine factory.
 */
import type { Node, Parser } from 'web-tree-sitter';
import type { CodeContext, Hunk } from '../../core/contracts';
import { changedNewLines } from '../diff';
import { type AstLanguage, matchSymbol, type SymbolMatch } from './languages';

export const MAX_SYMBOL_LINES = 300;
export const WINDOW_LINES = 20;
export const MAX_SIGNATURE_LINES = 10;

export interface ExpandInput {
  /** Raw head contents (parsed for structure only; never emitted). */
  rawContent: string;
  /** Redacted (marked) head contents with the same line structure as `rawContent`. */
  redactedLines: readonly string[];
  hunks: readonly Hunk[];
  language: AstLanguage | null;
  parser: Parser | null;
}

export interface ExpandResult {
  contexts: CodeContext[];
  /** True when tree-sitter threw and the line fallback was used. */
  astFailed: boolean;
}

interface Range {
  start: number; // 1-based, inclusive
  end: number;
}

interface SymbolHit {
  match: SymbolMatch;
  start: number;
  end: number;
  changed: Set<number>;
}

interface Ctx extends CodeContext {
  full: boolean;
}

/** Contiguous runs of changed new-side line numbers, per hunk. */
function changedBlocks(hunks: readonly Hunk[], lineCount: number): Range[] {
  const blocks: Range[] = [];
  for (const h of hunks) {
    let cur: Range | null = null;
    for (const raw of changedNewLines(h)) {
      const l = Math.min(Math.max(1, raw), lineCount);
      if (cur && l <= cur.end + 1) cur.end = Math.max(cur.end, l);
      else {
        if (cur) blocks.push(cur);
        cur = { start: l, end: l };
      }
    }
    if (cur) blocks.push(cur);
  }
  return blocks;
}

function firstNonSpace(line: string): number {
  const m = /\S/.exec(line);
  return m ? m.index : 0;
}

function rowsOf(node: Node): Range {
  const start = node.startPosition.row + 1;
  let end = node.endPosition.row + 1;
  if (node.endPosition.column === 0 && end > start) end--;
  return { start, end };
}

/** Nearest named symbol around [start, end]; the outermost anonymous function when none is named. */
function findSymbol(
  root: Node,
  lines: readonly string[],
  range: Range,
  lang: AstLanguage,
): SymbolMatch | null {
  const startLine = lines[range.start - 1] ?? '';
  const endLine = lines[range.end - 1] ?? '';
  const node = root.descendantForPosition(
    { row: range.start - 1, column: firstNonSpace(startLine) },
    { row: range.end - 1, column: Math.max(0, endLine.trimEnd().length - 1) },
  );
  let anonymous: SymbolMatch | null = null;
  for (let n: Node | null = node; n; n = n.parent) {
    const m = matchSymbol(n, lang);
    if (!m) continue;
    if (!m.anonymous) return m;
    anonymous = m;
  }
  return anonymous;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function windowsAround(lines: Iterable<number>, lo: number, hi: number): Range[] {
  const ranges: Range[] = [];
  for (const l of lines) {
    ranges.push({ start: Math.max(lo, l - WINDOW_LINES), end: Math.min(hi, l + WINDOW_LINES) });
  }
  return mergeRanges(ranges);
}

function slice(lines: readonly string[], r: Range): string {
  return lines.slice(r.start - 1, r.end).join('\n');
}

export function omittedMarker(n: number): string {
  return `... (${n} lines omitted) ...`;
}

function symbolContext(hit: SymbolHit, lines: readonly string[]): Ctx {
  const { start, end } = hit;
  const base = {
    kind: 'symbol' as const,
    ...(hit.match.name ? { name: hit.match.name } : {}),
    startLine: start,
    endLine: end,
  };
  if (end - start + 1 <= MAX_SYMBOL_LINES) {
    return { ...base, text: slice(lines, { start, end }), full: true };
  }
  const body = hit.match.inner.childForFieldName('body');
  const bodyRow = body ? body.startPosition.row + 1 : start;
  const sigEnd = Math.min(Math.max(start, bodyRow), start + MAX_SIGNATURE_LINES - 1, end);
  const ranges = mergeRanges([{ start, end: sigEnd }, ...windowsAround(hit.changed, start, end)]);
  const parts: string[] = [];
  let prev = start - 1;
  for (const r of ranges) {
    if (r.start > prev + 1) parts.push(omittedMarker(r.start - prev - 1));
    parts.push(slice(lines, r));
    prev = r.end;
  }
  if (prev < end) parts.push(omittedMarker(end - prev));
  return { ...base, text: parts.join('\n'), full: false };
}

/** Builds the code contexts for one file. Never throws. */
export function expandContexts(input: ExpandInput): ExpandResult {
  const lines = input.redactedLines;
  const lineCount = lines.length;
  if (lineCount === 0) return { contexts: [], astFailed: false };
  const blocks = changedBlocks(input.hunks, lineCount);
  if (blocks.length === 0) return { contexts: [], astFailed: false };

  const symbols = new Map<string, SymbolHit>();
  const loose: number[] = [];
  let astFailed = false;

  if (input.parser && input.language) {
    const lang = input.language;
    let tree: ReturnType<Parser['parse']> = null;
    try {
      tree = input.parser.parse(input.rawContent);
      if (!tree) throw new Error('parse returned null');
      const root = tree.rootNode;
      const add = (m: SymbolMatch, changed: Iterable<number>) => {
        const r = rowsOf(m.span);
        const key = `${r.start}:${r.end}`;
        let hit = symbols.get(key);
        if (!hit) {
          hit = { match: m, start: r.start, end: Math.min(r.end, lineCount), changed: new Set() };
          symbols.set(key, hit);
        }
        for (const l of changed) hit.changed.add(l);
      };
      for (const block of blocks) {
        const m = findSymbol(root, lines, block, lang);
        if (m && (m.kind === 'function' || block.start === block.end)) {
          add(m, rangeLines(block));
          continue;
        }
        if (!m && block.start === block.end) {
          loose.push(block.start);
          continue;
        }
        // Class-level or unresolved multi-line block: resolve line by line for precision.
        for (const l of rangeLines(block)) {
          const lm = findSymbol(root, lines, { start: l, end: l }, lang);
          if (lm) add(lm, [l]);
          else loose.push(l);
        }
      }
    } catch {
      astFailed = true;
      symbols.clear();
      loose.length = 0;
      for (const b of blocks) loose.push(...rangeLines(b));
    } finally {
      tree?.delete();
    }
  } else {
    for (const b of blocks) loose.push(...rangeLines(b));
  }

  const contexts: Ctx[] = [];
  for (const hit of symbols.values()) contexts.push(symbolContext(hit, lines));
  for (const w of windowsAround(loose, 1, lineCount)) {
    contexts.push({ kind: 'lines', startLine: w.start, endLine: w.end, text: slice(lines, w), full: true });
  }
  return { contexts: prune(contexts, input.hunks), astFailed };
}

function rangeLines(r: Range): number[] {
  const out: number[] = [];
  for (let l = r.start; l <= r.end; l++) out.push(l);
  return out;
}

/** Drops contexts already shown by a hunk or contained in another full context; sorts the rest. */
function prune(contexts: Ctx[], hunks: readonly Hunk[]): CodeContext[] {
  const hunkRanges = hunks
    .filter((h) => h.newLines > 0)
    .map((h) => ({ start: h.newStart, end: h.newStart + h.newLines - 1 }));
  const covered = (c: Ctx) => hunkRanges.some((h) => h.start <= c.startLine && c.endLine <= h.end);
  const kept = contexts.filter((c, i) => {
    if (covered(c)) return false;
    return !contexts.some(
      (o, j) =>
        j !== i &&
        o.full &&
        o.startLine <= c.startLine &&
        c.endLine <= o.endLine &&
        (o.startLine !== c.startLine || o.endLine !== c.endLine || j < i),
    );
  });
  kept.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine || (a.kind < b.kind ? -1 : 1));
  return kept.map(({ full: _full, ...c }) => c);
}
