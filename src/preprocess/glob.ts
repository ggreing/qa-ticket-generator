/**
 * Dependency-free glob matcher (PRE-02). Kept deliberately small and regex-free so the
 * semantics are trivial to port to Rust and fully deterministic.
 *
 * Supported syntax:
 * - `**`  as a whole path segment: zero or more segments
 * - `*`   any run of characters inside one segment (never `/`)
 * - `?`   exactly one character inside one segment (never `/`)
 * - `{a,b}` alternatives (nestable, expanded before matching)
 * - `\x`  the literal character `x`
 *
 * Normalisation (gitignore-like):
 * - a leading `./` or `/` is ignored (patterns are anchored at the repo root)
 * - a trailing `/` means "everything below": `dist/` == `dist/**`
 * - a pattern without any `/` matches the basename at any depth: `*.snap` == `**\/*.snap`
 *
 * Matching is case-sensitive. Character classes (`[abc]`) are not supported; `[` is literal.
 */

type SegToken = { kind: 'lit'; ch: string } | { kind: 'star' } | { kind: 'any' };
type Segment = { kind: 'globstar' } | { kind: 'seg'; tokens: SegToken[] };

/** Maximum alternatives produced by brace expansion (guards against `{a,b}{c,d}...` blowups). */
const MAX_BRACE_EXPANSION = 256;

const cache = new Map<string, (path: string) => boolean>();

/** Returns a cached matcher for `pattern`. Pure; safe to call on every path. */
export function compileGlob(pattern: string): (path: string) => boolean {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const alternatives = expandBraces(pattern.trim()).map((p) => parsePattern(normalizePattern(p)));
  const matcher = (path: string): boolean => {
    const segs = normalizePath(path).split('/');
    return alternatives.some((pat) => matchSegments(pat, segs));
  };
  cache.set(pattern, matcher);
  return matcher;
}

/** True when `path` matches at least one of `patterns`. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (compileGlob(p)(path)) return true;
  }
  return false;
}

/** Strips `./` and leading slashes and converts backslashes so API and CLI paths compare equally. */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  return p;
}

function normalizePattern(pattern: string): string {
  let p = pattern;
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/') && p.length > 1) p = p.slice(1);
  if (p.endsWith('/')) p = `${p}**`;
  if (!p.includes('/')) p = `**/${p}`;
  return p;
}

/** Expands `{a,b}` groups (nested allowed). Unbalanced braces are treated literally. */
export function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  const stack = [pattern];
  while (stack.length > 0) {
    const p = stack.pop() as string;
    const group = findBraceGroup(p);
    if (!group) {
      out.push(p);
      continue;
    }
    const prefix = p.slice(0, group.open);
    const suffix = p.slice(group.close + 1);
    // Push in reverse so alternatives come out in written order.
    for (let i = group.options.length - 1; i >= 0; i--) {
      stack.push(prefix + group.options[i] + suffix);
    }
    if (out.length + stack.length > MAX_BRACE_EXPANSION) break;
  }
  return out.length > 0 ? out.slice(0, MAX_BRACE_EXPANSION) : [pattern];
}

function findBraceGroup(p: string): { open: number; close: number; options: string[] } | null {
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch !== '{') continue;
    let depth = 0;
    let last = i + 1;
    const options: string[] = [];
    for (let j = i; j < p.length; j++) {
      const c = p[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          options.push(p.slice(last, j));
          if (options.length < 2) break; // `{x}` is literal
          return { open: i, close: j, options };
        }
      } else if (c === ',' && depth === 1) {
        options.push(p.slice(last, j));
        last = j + 1;
      }
    }
  }
  return null;
}

function parsePattern(pattern: string): Segment[] {
  return pattern.split('/').map((seg): Segment => {
    if (seg === '**') return { kind: 'globstar' };
    const tokens: SegToken[] = [];
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i] as string;
      if (ch === '\\' && i + 1 < seg.length) {
        tokens.push({ kind: 'lit', ch: seg[++i] as string });
      } else if (ch === '*') {
        // Collapse runs (`**` inside a segment behaves like `*`).
        if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' });
      } else if (ch === '?') {
        tokens.push({ kind: 'any' });
      } else {
        tokens.push({ kind: 'lit', ch });
      }
    }
    return { kind: 'seg', tokens };
  });
}

/** Segment-level match with `**` support; dynamic programming keeps it O(pattern × path). */
function matchSegments(pattern: Segment[], path: string[]): boolean {
  const P = pattern.length;
  const S = path.length;
  // dp[i][j] = pattern[i..] matches path[j..]
  let next = new Array<boolean>(S + 1).fill(false);
  next[S] = true; // empty pattern matches empty path
  for (let i = P - 1; i >= 0; i--) {
    const cur = new Array<boolean>(S + 1).fill(false);
    const seg = pattern[i] as Segment;
    for (let j = S; j >= 0; j--) {
      if (seg.kind === 'globstar') {
        // zero segments, or consume one and stay on `**`
        cur[j] = (next[j] as boolean) || (j < S && (cur[j + 1] as boolean));
      } else {
        cur[j] = j < S && matchSegment(seg.tokens, path[j] as string) && (next[j + 1] as boolean);
      }
    }
    next = cur;
  }
  return next[0] as boolean;
}

/** Classic linear-time wildcard match with single-star backtracking. */
function matchSegment(tokens: SegToken[], text: string): boolean {
  let t = 0;
  let s = 0;
  let starT = -1;
  let starS = 0;
  while (s < text.length) {
    const tok = tokens[t];
    if (tok && (tok.kind === 'any' || (tok.kind === 'lit' && tok.ch === text[s]))) {
      t++;
      s++;
    } else if (tok && tok.kind === 'star') {
      starT = t++;
      starS = s;
    } else if (starT >= 0) {
      t = starT + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (t < tokens.length && tokens[t]?.kind === 'star') t++;
  return t === tokens.length;
}
