/** Builders for preprocess tests and golden fixture sources. Synthetic data only. */
import type {
  ChangedFile,
  FileStatus,
  PrdDocument,
  PreprocessInput,
  PreprocessOptions,
} from '../../src/core/contracts';

export const ALL_AST_LANGUAGES = ['typescript', 'tsx', 'javascript', 'python', 'java', 'go'];

/** Mirrors DEFAULTS in src/core/config.ts, spelled out so fixtures are self-contained JSON. */
export function options(overrides: Partial<PreprocessOptions> = {}): PreprocessOptions {
  return {
    tokenBudget: 150_000,
    exclude: [],
    include: [],
    scoring: {
      prdKeyword: 3,
      changeSize: 1,
      domainPath: 2,
      testOrConfigPenalty: 2,
      boostPaths: [],
      penalizePaths: [],
    },
    astLanguages: [...ALL_AST_LANGUAGES],
    reservedTokens: 6_000,
    ...overrides,
  };
}

export function input(
  files: ChangedFile[],
  prdDocuments: PrdDocument[] = [],
  opts: Partial<PreprocessOptions> = {},
): PreprocessInput {
  return { files, prdDocuments, options: options(opts) };
}

/** Removes the common indentation and the first/last empty line of a template literal. */
export function dedent(text: string): string {
  const lines = text
    .replace(/^\n/, '')
    .replace(/\n[ \t]*$/, '')
    .split('\n');
  const indent = Math.min(
    ...lines.filter((l) => l.trim() !== '').map((l) => (/^[ \t]*/.exec(l) as RegExpExecArray)[0].length),
  );
  return lines.map((l) => l.slice(indent)).join('\n');
}

/** One hunk; counts are computed from the body. */
export function hunk(oldStart: number, newStart: number, body: string[], section = ''): string {
  const oldLines = body.filter((l) => l[0] === ' ' || l[0] === '-').length;
  const newLines = body.filter((l) => l[0] === ' ' || l[0] === '+').length;
  return [
    `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${section ? ` ${section}` : ''}`,
    ...body,
  ].join('\n');
}

function counts(patch: string | undefined): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of (patch ?? '').split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line[0] === '+' && !line.startsWith('+++')) additions++;
    else if (line[0] === '-' && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export function file(
  path: string,
  patch: string | undefined,
  extra: Partial<ChangedFile> & { status?: FileStatus } = {},
): ChangedFile {
  return {
    path,
    status: 'modified',
    ...counts(patch),
    ...(patch !== undefined ? { patch } : {}),
    patchMissing: false,
    ...extra,
  };
}

export function added(path: string, content: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return file(path, unifiedDiff('', content), { status: 'added', ...extra });
}

export function removed(path: string, content: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return file(path, unifiedDiff(content, ''), { status: 'removed', ...extra });
}

/** Modified file whose patch is computed from old/new contents; head contents included by default. */
export function modified(
  path: string,
  oldText: string,
  newText: string,
  extra: Partial<ChangedFile> & { withHead?: boolean } = {},
): ChangedFile {
  const { withHead = true, ...rest } = extra;
  return file(path, unifiedDiff(oldText, newText), {
    ...(withHead ? { headContent: newText } : {}),
    ...rest,
  });
}

export function prd(
  id: string,
  title: string,
  body: string,
  acceptanceCriteria: string[] = [],
  meta = {},
): PrdDocument {
  return {
    ref: { source: 'github', id: `acme/shop#${id}`, raw: `#${id}` },
    title,
    bodyMarkdown: body,
    acceptanceCriteria,
    url: `https://github.com/acme/shop/issues/${id}`,
    meta,
  };
}

function splitText(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = { kind: ' ' | '-' | '+'; text: string; oldNo: number; newNo: number };

/** Minimal LCS-based unified diff (3 lines of context), good enough for synthetic fixtures. */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  const a = splitText(oldText);
  const b = splitText(newText);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      ops.push({ kind: '-', text: a[i]!, oldNo: i + 1, newNo: j });
      i++;
    } else {
      ops.push({ kind: '+', text: b[j]!, oldNo: i, newNo: j + 1 });
      j++;
    }
  }
  const changes = ops.map((o, k) => (o.kind === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (changes.length === 0) return '';
  const groups: [number, number][] = [];
  for (const k of changes) {
    const last = groups[groups.length - 1];
    if (last && k - last[1] <= 2 * context + 1) last[1] = k;
    else groups.push([k, k]);
  }
  const out: string[] = [];
  for (const [s, e] of groups) {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length - 1, e + context);
    const slice = ops.slice(from, to + 1);
    const oldOps = slice.filter((o) => o.kind !== '+');
    const newOps = slice.filter((o) => o.kind !== '-');
    const oldStart = oldOps.length > 0 ? oldOps[0]!.oldNo : slice[0]!.oldNo;
    const newStart = newOps.length > 0 ? newOps[0]!.newNo : slice[0]!.newNo;
    out.push(`@@ -${oldStart},${oldOps.length} +${newStart},${newOps.length} @@`);
    for (const o of slice) out.push(`${o.kind}${o.text}`);
  }
  return out.join('\n');
}

/** Deterministic pseudo-random generator for synthetic data (tests only). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
