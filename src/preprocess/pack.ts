/**
 * Packing (PRE-09). Files arrive scored; they are packed by score into the per-call code budget.
 *
 * - Everything fits → `single`, one chunk.
 * - Otherwise → `map_reduce`: files are grouped by directory (module); groups are placed first-fit
 *   in score order, preferring the chunk that shares the longest directory prefix. Each chunk is
 *   ≤ the code budget, and chunk[0] holds the highest-scored file (the cost guard drops chunks
 *   from the end).
 * - A group over budget is split into files; a file over budget first loses its contexts, then is
 *   split into hunk parts; if a single hunk still does not fit, the file is `too_large`.
 */
import type { CodeChunk, Hunk, PackedFile } from '../core/contracts';
import { dirname } from './noise';
import { estimateTokens } from './tokens';

export const FILE_OVERHEAD_TOKENS = 16;
export const CONTEXT_OVERHEAD_TOKENS = 8;

export type UnsizedFile = Omit<PackedFile, 'estimatedTokens'>;

/** Estimated tokens of a packed file as rendered into a prompt. */
export function fileTokens(f: UnsizedFile): number {
  let t = FILE_OVERHEAD_TOKENS + estimateTokens(f.path);
  if (f.previousPath) t += estimateTokens(f.previousPath);
  if (f.summary) t += estimateTokens(f.summary);
  for (const h of f.hunks) t += estimateTokens(h.header) + estimateTokens(h.text);
  for (const c of f.contexts)
    t += CONTEXT_OVERHEAD_TOKENS + estimateTokens(c.text) + estimateTokens(c.name ?? '');
  return t;
}

export function sized(f: UnsizedFile): PackedFile {
  return { ...f, estimatedTokens: fileTokens(f) };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Score descending, then path ascending (code-unit order, locale independent). */
export function byPriority(a: PackedFile, b: PackedFile): number {
  return b.score - a.score || cmp(a.path, b.path);
}

export interface PackResult {
  mode: 'single' | 'map_reduce';
  chunks: CodeChunk[];
  tooLarge: string[];
}

interface Unit {
  dir: string;
  score: number;
  files: PackedFile[];
  tokens: number;
}

function sumTokens(files: readonly PackedFile[]): number {
  return files.reduce((s, f) => s + f.estimatedTokens, 0);
}

function makeChunks(groups: PackedFile[][]): CodeChunk[] {
  return groups.map((files, i) => {
    const sorted = [...files].sort(byPriority);
    return { id: `c${i + 1}`, files: sorted, estimatedTokens: sumTokens(sorted) };
  });
}

/** Splits an over-budget file into budget-sized parts, or returns null when a hunk is too large. */
export function splitFile(file: PackedFile, budget: number): PackedFile[] | null {
  const noCtx = sized({ ...file, contexts: [] });
  if (noCtx.estimatedTokens <= budget) return [noCtx];
  if (file.hunks.length < 2) return null;
  const parts: Hunk[][] = [];
  let cur: Hunk[] = [];
  const partTokens = (hunks: Hunk[]) =>
    fileTokens({ ...file, contexts: [], hunks, summary: 'part 0000 of 0000 (file split by hunks)' });
  for (const h of file.hunks) {
    if (partTokens([h]) > budget) return null;
    if (cur.length > 0 && partTokens([...cur, h]) > budget) {
      parts.push(cur);
      cur = [];
    }
    cur.push(h);
  }
  if (cur.length > 0) parts.push(cur);
  return parts.map((hunks, i) =>
    sized({
      ...file,
      contexts: [],
      hunks,
      summary: `part ${i + 1} of ${parts.length} (file split by hunks)`,
    }),
  );
}

function commonPrefix(a: string, b: string): number {
  const x = a === '' ? [] : a.split('/');
  const y = b === '' ? [] : b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

export function pack(files: readonly PackedFile[], budget: number): PackResult {
  const sorted = [...files].sort(byPriority);
  if (sorted.length === 0) return { mode: 'single', chunks: [], tooLarge: [] };
  if (sumTokens(sorted) <= budget) return { mode: 'single', chunks: makeChunks([sorted]), tooLarge: [] };

  const tooLarge: string[] = [];
  const byDir = new Map<string, PackedFile[]>();
  for (const f of sorted) {
    const d = dirname(f.path);
    const list = byDir.get(d);
    if (list) list.push(f);
    else byDir.set(d, [f]);
  }

  const units: Unit[] = [];
  for (const [dir, group] of byDir) {
    const tokens = sumTokens(group);
    if (tokens <= budget) {
      units.push({ dir, score: (group[0] as PackedFile).score, files: group, tokens });
      continue;
    }
    for (const f of group) {
      const parts = f.estimatedTokens <= budget ? [f] : splitFile(f, budget);
      if (!parts) {
        tooLarge.push(f.path);
        continue;
      }
      for (const p of parts) units.push({ dir, score: p.score, files: [p], tokens: p.estimatedTokens });
    }
  }
  // Highest score first; ties by directory then first path, so placement is deterministic.
  units.sort(
    (a, b) =>
      b.score - a.score ||
      cmp(a.dir, b.dir) ||
      cmp((a.files[0] as PackedFile).path, (b.files[0] as PackedFile).path),
  );

  const chunks: { files: PackedFile[]; tokens: number; dirs: string[] }[] = [];
  for (const u of units) {
    let best = -1;
    let bestSim = -1;
    chunks.forEach((c, i) => {
      if (c.tokens + u.tokens > budget) return;
      const sim = Math.max(...c.dirs.map((d) => commonPrefix(d, u.dir)));
      if (sim > bestSim) {
        best = i;
        bestSim = sim;
      }
    });
    if (best < 0) {
      chunks.push({ files: [...u.files], tokens: u.tokens, dirs: [u.dir] });
    } else {
      const c = chunks[best] as (typeof chunks)[number];
      c.files.push(...u.files);
      c.tokens += u.tokens;
      if (!c.dirs.includes(u.dir)) c.dirs.push(u.dir);
    }
  }
  // One chunk left (e.g. only a too_large file overflowed): a single call is enough.
  const mode = chunks.length > 1 ? 'map_reduce' : 'single';
  return { mode, chunks: makeChunks(chunks.map((c) => c.files)), tooLarge };
}
