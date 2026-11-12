/**
 * Secret redaction (PRE-05) for diff hunks, head file contents and PRD documents.
 *
 * Two-phase design so counts are exact for what actually leaves the engine:
 * 1. {@link redactText} / {@link redactDiffBody} replace secrets with an internal marker
 *    (`\uE000REDACTED:<type>]`) that has the SAME length as the final `[REDACTED:<type>]`, so
 *    token estimates and truncation can run on marked text.
 * 2. {@link finalizeRedactions} turns markers into `[REDACTED:<type>]` and counts them; the engine
 *    calls it only on text that ends up in the output.
 *
 * Every replacement preserves the number of newlines of the matched text, so line numbers of
 * head contents and the line structure of diff hunks stay valid after redaction.
 */

const MARK = '\uE000';
const MARK_RE = /\uE000REDACTED:([a-z0-9_]+)\]/g;

/** Internal marker for a redacted value; same length as the final `[REDACTED:<type>]`. */
export function marker(type: string): string {
  return `${MARK}REDACTED:${type}]`;
}

interface PatternRule {
  type: string;
  re: RegExp;
  /** When set, only this capture group is replaced (the rest of the match is kept). */
  group?: number;
  /** Optional veto on the captured secret (e.g. placeholders). */
  keep?: (secret: string) => boolean;
}

const isPlaceholder = (v: string): boolean =>
  v.startsWith('$') || v.includes('{{') || v.includes('${') || v.startsWith('<') || /^(.)\1*$/.test(v);

/**
 * Pattern rules, applied in order (specific providers first, generic assignment rules last).
 * Exported so tests and the README table stay in sync with the implementation.
 */
export const PATTERN_RULES: readonly PatternRule[] = [
  {
    type: 'private_key',
    re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s\\:,"'-]*?-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    // Unterminated block (e.g. cut off at a hunk edge): header plus following base64-looking lines.
    type: 'private_key',
    re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----(?:\n[ \t]*(?:[A-Za-z0-9+/=]{8,}|Proc-Type:[^\n]*|DEK-Info:[^\n]*)|\n[ \t]*(?=\n))*/g,
  },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { type: 'aws_access_key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { type: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { type: 'github_token', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { type: 'gitlab_token', re: /\bgl(?:pat|ptt|dt|rt|soat|cbt|oas)-[A-Za-z0-9_-]{20,}/g },
  {
    type: 'slack_webhook',
    re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{8,}/g,
  },
  { type: 'slack_token', re: /\bxox[abposre]-[A-Za-z0-9-]{10,250}/g },
  { type: 'slack_token', re: /\bxapp-\d-[A-Za-z0-9]+-\d+-[A-Za-z0-9]+/g },
  { type: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,99}\b/g },
  { type: 'stripe_key', re: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
  { type: 'google_api_key', re: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  {
    type: 'url_password',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)([^\s@/'"`]+)@/gi,
    group: 2,
    keep: isPlaceholder,
  },
  { type: 'bearer_token', re: /\b(Bearer[ \t]+)([A-Za-z0-9._~+/-]{20,}=*)/g, group: 2 },
];

// ─────────────────────────── assignment rules ───────────────────────────

// The lookbehind keeps the scan from starting inside an identifier (linear instead of quadratic).
const KEY = String.raw`(?<![\w.-])(?:"([A-Za-z_][\w.-]*)"|'([A-Za-z_][\w.-]*)'|([A-Za-z_][\w.-]*))`;
// `key: Type = value` (annotated), `:=`, `=>`, `=`, `:` — but not `==`, `=>` arrows of other kinds, `=~`.
const OP = String.raw`[ \t]*(:[ \t]*[A-Za-z_][\w.\[\]|<>, ]{0,40}?[ \t]*=(?![=>~])|:=|=>|=(?![=>~])|:)[ \t]*`;
const VALUE = String.raw`(?:"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|\x60([^\x60\\\n$]*)\x60|([^\s'"\x60,;(){}\[\]<>]+))`;
const ASSIGNMENT_RE = new RegExp(KEY + OP + VALUE, 'g');

/** Minimum length / entropy of the high-entropy rule (SPEC PRE-05). */
export const HIGH_ENTROPY_MIN_LENGTH = 20;
export const HIGH_ENTROPY_MAX_LENGTH = 500;
export const HIGH_ENTROPY_THRESHOLD = 4.0;
const MIN_SECRET_LENGTH = 4;

// biome-ignore format: compact keyword table
const NON_SECRET_VALUES = new Set([
  'null', 'none', 'nil', 'undefined', 'true', 'false', 'string', 'str', 'number', 'int', 'integer', 'float',
  'bool', 'boolean', 'bytes', 'any', 'unknown', 'object', 'optional', 'required', 'secret', 'secrets',
  'password', 'passwd', 'token', 'apikey', 'api_key', 'redacted', 'example', 'placeholder', 'your_token',
  'your_api_key', 'your_password',
]);

/** Keys whose values are public identifiers even when they look random (hashes, ids, versions). */
// biome-ignore format: compact keyword table
const PUBLIC_KEY_SUFFIXES = [
  'hash', 'sha', 'sha1', 'sha256', 'sha512', 'checksum', 'digest', 'integrity', 'etag', 'commit', 'revision',
  'version', 'uuid', 'guid', 'resolved', 'url', 'uri', 'href', 'src', 'path', 'file', 'filename', 'name', 'id',
];

export type SecretKind = 'password' | 'secret' | 'token' | 'api_key' | 'aws_secret_key';

/** Classifies an assignment key by its last segment (`db.password`, `GITHUB_TOKEN`, `apiKey`, ...). */
export function secretKind(key: string): SecretKind | null {
  const full = key.toLowerCase().replace(/[_.-]/g, '');
  if (full.includes('aws') && full.includes('secret')) return 'aws_secret_key';
  const last = (key.split('.').pop() ?? key).toLowerCase().replace(/[_-]/g, '');
  if (/(?:password|passwd|passphrase|pwd)$/.test(last)) return 'password';
  if (last.endsWith('token')) return 'token';
  if (/(?:apikey|accesskey|authkey)$/.test(last)) return 'api_key';
  if (/(?:secret|secretkey|privatekey)$/.test(last)) return 'secret';
  return null;
}

function isPublicKey(key: string): boolean {
  const last = (key.split('.').pop() ?? key).toLowerCase().replace(/[_-]/g, '');
  return PUBLIC_KEY_SUFFIXES.some((s) => last.endsWith(s));
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * High-entropy literal check (only ever called in an assignment context). Excludes the usual false
 * positives: hex digests (git SHA, md5, sha256), UUIDs, SRI hashes, base64 media and paths.
 */
export function isHighEntropySecret(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH || value.length > HIGH_ENTROPY_MAX_LENGTH) return false;
  if (!/^[A-Za-z0-9+/=_.~-]+$/.test(value)) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (/^[0-9a-f-]+$/i.test(value)) return false; // hex digests, UUIDs
  if (/^sha(?:1|256|384|512)-/.test(value)) return false; // subresource integrity
  if (/^(?:iVBORw0KGgo|\/9j\/|R0lGOD|PHN2Zy|UklGR|AAAA)/.test(value)) return false; // base64 media
  if (/^\.{0,2}\//.test(value) || /\.[A-Za-z]{1,5}$/.test(value)) return false; // paths, file names
  return shannonEntropy(value) >= HIGH_ENTROPY_THRESHOLD;
}

const MEMBER_CHAIN = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+[!?]?$/;
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z_$]*[!?]?$/;

function isLiteralSecret(value: string, quoted: boolean, key: string, op: string): boolean {
  if (value.length < MIN_SECRET_LENGTH || /\s/.test(value) || isPlaceholder(value)) return false;
  if (value.includes('%(') || value.includes('%s')) return false;
  const lower = value.toLowerCase();
  if (NON_SECRET_VALUES.has(lower)) return false;
  const last = (key.split('.').pop() ?? key).toLowerCase();
  if (lower === last || lower === last.replace(/[_-]/g, '')) return false; // i18n labels: password: "Password"
  if (quoted) return true;
  if (/^\d+$/.test(value)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(key) && op === '=') return true; // dotenv / shell: API_TOKEN=abc
  if (BARE_IDENTIFIER.test(value) || MEMBER_CHAIN.test(value)) return false; // code references
  return true;
}

/** Redaction type for one `key op value` match, or null to keep it. */
function assignmentType(groups: (string | undefined)[]): string | null {
  const [k1, k2, k3, rawOp, v1, v2, v3, v4] = groups;
  const key = (k1 ?? k2 ?? k3) as string;
  const value = v1 ?? v2 ?? v3 ?? v4 ?? '';
  if (value === '' || value.includes(MARK)) return null;
  const quoted = v4 === undefined;
  const kind = secretKind(key);
  if (kind && isLiteralSecret(value, quoted, key, (rawOp ?? '').trim())) return kind;
  if (!isPublicKey(key) && isHighEntropySecret(value)) return 'high_entropy';
  return null;
}

/**
 * Line pre-filter for the assignment rules (they never span lines). A line is scanned only when
 * it contains a secret-key word (case-insensitive `pass|pwd|token|key|secret`) or a run of
 * ≥ {@link HIGH_ENTROPY_MIN_LENGTH} token characters; no other line can produce a redaction.
 */
const KEYWORD_HINT = /pass|pwd|token|key|secret/gi;
const LONG_RUN_HINT = /(?<![A-Za-z0-9+/=_.~-])[A-Za-z0-9+/=_.~-]{20}/g;

function candidateLines(text: string): { start: number; end: number }[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lines = new Set<number>();
  for (const re of [KEYWORD_HINT, LONG_RUN_HINT]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const line = lineOf(m.index);
      lines.add(line);
      // Skip to the next line: one hit is enough.
      re.lastIndex = Math.max(
        re.lastIndex,
        line + 1 < starts.length ? (starts[line + 1] as number) : text.length,
      );
    }
  }
  return [...lines]
    .sort((a, b) => a - b)
    .map((l) => ({
      start: starts[l] as number,
      end: l + 1 < starts.length ? (starts[l + 1] as number) - 1 : text.length,
    }));
}

/** Applies the assignment rules only to candidate lines (same result as scanning everything). */
function redactAssignments(text: string): string {
  if (!text.includes('=') && !text.includes(':')) return text;
  let out = '';
  let last = 0;
  for (const { start, end } of candidateLines(text)) {
    const line = text.slice(start, end);
    const red = redactAssignmentLine(line);
    if (red === line) continue;
    out += text.slice(last, start) + red;
    last = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Scans `key op value` assignments. A kept match is re-scanned from the end of its key, because
 * what followed may hold the real assignment (`ticket: password = "x"`, `a: token: "x"`).
 */
function redactAssignmentLine(text: string): string {
  if (!text.includes('=') && !text.includes(':')) return text;
  const re = new RegExp(ASSIGNMENT_RE.source, 'g');
  let out = '';
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const groups = m.slice(1);
    const value = groups[4] ?? groups[5] ?? groups[6] ?? groups[7] ?? '';
    const tail = groups[7] === undefined ? 1 : 0; // closing quote
    const end = m.index + m[0].length;
    const valueStart = end - tail - value.length;
    const type = assignmentType(groups);
    if (type) {
      out += text.slice(last, valueStart) + marker(type);
      last = end - tail;
      re.lastIndex = end;
    } else {
      // Re-scan right after the key: the "annotation" or the value may hold the real key.
      const keyLen = groups[2] !== undefined ? groups[2].length : (groups[0] ?? groups[1] ?? '').length + 2;
      re.lastIndex = m.index + Math.max(1, keyLen);
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

// ─────────────────────────── public API ───────────────────────────

function preserveNewlines(matched: string, replacement: string): string {
  let nl = 0;
  for (let i = 0; i < matched.length; i++) if (matched.charCodeAt(i) === 10) nl++;
  return nl === 0 ? replacement : replacement + '\n'.repeat(nl);
}

/**
 * Redacts secrets in raw text and returns marked text (see module doc). Call it exactly once per
 * raw input: it neutralises any pre-existing marker characters so counts cannot be spoofed.
 *
 * Public API: `src/adapters/wire.ts` combines it with {@link finalizeRedactions} to redact PR
 * titles and bodies (PRE-05). Keep the signature and the marker → finalize contract stable.
 */
export function redactText(raw: string): string {
  let text = raw.includes(MARK) ? raw.replaceAll(MARK, '\uFFFD') : raw;
  for (const rule of PATTERN_RULES) {
    rule.re.lastIndex = 0;
    if (!rule.re.test(text)) continue;
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, (match: string, ...groups: unknown[]) => {
      if (rule.group === undefined) return preserveNewlines(match, marker(rule.type));
      const secret = groups[rule.group - 1] as string;
      if (rule.keep?.(secret)) return match;
      const before = rule.group > 1 ? (groups.slice(0, rule.group - 1) as string[]).join('') : '';
      const after = match.slice(before.length + secret.length);
      return before + marker(rule.type) + after;
    });
  }
  return redactAssignments(text);
}

/**
 * Redacts a hunk body: diff prefixes (`+`, `-`, ` `, `\`) are stripped before matching and put
 * back afterwards, so multi-line secrets (PEM blocks) are found and the hunk shape is preserved.
 */
export function redactDiffBody(body: string): string {
  if (body === '') return body;
  const lines = body.split('\n');
  const prefixes: string[] = [];
  const contents: string[] = [];
  for (const line of lines) {
    prefixes.push(line.slice(0, 1));
    contents.push(line.slice(1));
  }
  const joined = contents.join('\n');
  const red = redactText(joined);
  if (red === joined) return body;
  const out = red.split('\n');
  return out.map((c, i) => (prefixes[i] ?? '') + c).join('\n');
}

/**
 * Converts internal markers into `[REDACTED:<type>]`, adding one count per occurrence.
 * Public API (see {@link redactText}); keep the signature stable.
 */
export function finalizeRedactions(text: string, counts: Map<string, number>): string {
  if (!text.includes(MARK)) return text;
  return text.replace(MARK_RE, (_m: string, type: string) => {
    counts.set(type, (counts.get(type) ?? 0) + 1);
    return `[REDACTED:${type}]`;
  });
}

/** Moves a cut position back so it never splits a marker or a surrogate pair. */
export function safeCut(text: string, cut: number): number {
  let c = Math.max(0, Math.min(cut, text.length));
  const open = text.lastIndexOf(MARK, c - 1);
  if (open >= 0) {
    const close = text.indexOf(']', open);
    if (close >= c) c = open;
  }
  if (c > 0 && c < text.length) {
    const code = text.charCodeAt(c - 1);
    if (code >= 0xd800 && code <= 0xdbff) c--;
  }
  return c;
}
