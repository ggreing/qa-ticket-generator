/**
 * Unified diff parsing (PRE-04). Accepts the GitHub API `patch` field (hunks only) and also full
 * `git diff` output for one file (header lines such as `diff --git`, `rename from`, `---`/`+++`).
 */
import type { Hunk } from '../core/contracts';

export interface ParsedPatch {
  hunks: Hunk[];
  /** From `rename from` / `--- a/...` headers when present (CLI diffs); GitHub patches have none. */
  renameFrom?: string;
  renameTo?: string;
  /** `new file mode` / `deleted file mode` headers, when present. */
  newFile: boolean;
  deletedFile: boolean;
  /** `Binary files ... differ` or `GIT binary patch`. */
  binary: boolean;
}

export const NO_NEWLINE_MARKER = '\\ No newline at end of file';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parses one file's patch into hunks. Malformed lines before the first hunk are ignored. */
export function parsePatch(patch: string): ParsedPatch {
  const result: ParsedPatch = { hunks: [], newFile: false, deletedFile: false, binary: false };
  const lines = patch.split('\n');
  // Drop the empty string produced by a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let current: { hunk: Hunk; body: string[] } | null = null;
  const flush = () => {
    if (current) {
      current.hunk.text = current.body.join('\n');
      result.hunks.push(current.hunk);
      current = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const m = HUNK_HEADER.exec(line);
    if (m) {
      flush();
      current = {
        hunk: {
          header: line,
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
          text: '',
        },
        body: [],
      };
      continue;
    }
    if (current) {
      const c = line[0];
      if (c === '+' || c === '-' || c === ' ' || c === '\\') {
        current.body.push(line);
      } else if (line === '') {
        // Some tools strip the single space of empty context lines.
        current.body.push(' ');
      } else if (line.startsWith('diff --git ')) {
        flush();
      } else {
        current.body.push(` ${line}`);
      }
      continue;
    }
    parseHeaderLine(line, result);
  }
  flush();
  return result;
}

function parseHeaderLine(line: string, result: ParsedPatch): void {
  if (line.startsWith('rename from ')) result.renameFrom = line.slice('rename from '.length);
  else if (line.startsWith('rename to ')) result.renameTo = line.slice('rename to '.length);
  else if (line.startsWith('new file mode')) result.newFile = true;
  else if (line.startsWith('deleted file mode')) result.deletedFile = true;
  else if (line.startsWith('Binary files ') || line === 'GIT binary patch') result.binary = true;
}

/**
 * New-side line numbers that changed in `hunk`. A deletion is anchored to the new-side line at
 * the deletion point (clamped to ≥ 1), so pure-deletion hunks still map to a location.
 */
export function changedNewLines(hunk: Hunk): number[] {
  const out: number[] = [];
  let newLine = hunk.newStart;
  let lastAnchor = -1;
  for (const line of hunk.text.split('\n')) {
    const c = line[0];
    if (c === '+') {
      out.push(newLine);
      newLine++;
    } else if (c === '-') {
      const anchor = Math.max(1, newLine);
      if (anchor !== lastAnchor) out.push(anchor);
      lastAnchor = anchor;
    } else if (c === '\\') {
      // `\ No newline at end of file` — not a line of the file.
    } else {
      newLine++;
    }
  }
  return dedupeSorted(out);
}

/**
 * Lines of one side of the hunk (`new` = context + additions, `old` = context + deletions),
 * without the diff prefix. Used for generated-header detection.
 */
export function sideLines(hunk: Hunk, side: 'old' | 'new'): string[] {
  const skip = side === 'new' ? '-' : '+';
  const out: string[] = [];
  for (const line of hunk.text.split('\n')) {
    const c = line[0];
    if (c === skip || c === '\\') continue;
    out.push(line.slice(1));
  }
  return out;
}

/** Number of `+`/`-` lines in a hunk. */
export function countChanges(hunk: Hunk): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of hunk.text.split('\n')) {
    if (line[0] === '+') additions++;
    else if (line[0] === '-') deletions++;
  }
  return { additions, deletions };
}

function dedupeSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (out[out.length - 1] !== v) out.push(v);
  return out;
}
