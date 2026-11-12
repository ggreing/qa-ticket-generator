/**
 * Dependency manifest summaries (PRE-03). Dependency/config manifests are NOT dropped as noise;
 * their raw diff is replaced by a compact, deterministic summary such as
 * `added: stripe@^15.0.0; removed: lodash@^4.17.21; changed: react ^18.2.0 -> ^19.0.0`.
 *
 * Parsing is line-based on the hunks (the API does not give us both full versions), with section
 * tracking from the hunk's context lines. Non-dependency changes are listed under `other:`.
 */
import type { Hunk } from '../core/contracts';
import { basename } from './noise';

export type ManifestKind = 'npm' | 'composer' | 'go' | 'pip' | 'pyproject' | 'cargo' | 'pipfile' | 'gemfile';

/** Max raw lines listed under `other:` before collapsing into `(+N more)`. */
export const MAX_OTHER_LINES = 10;
/** Max characters kept per `other:` line. */
export const MAX_OTHER_LINE_LENGTH = 120;

export function manifestKind(path: string): ManifestKind | null {
  const base = basename(path);
  switch (base) {
    case 'package.json':
      return 'npm';
    case 'composer.json':
      return 'composer';
    case 'go.mod':
      return 'go';
    case 'pyproject.toml':
      return 'pyproject';
    case 'Cargo.toml':
      return 'cargo';
    case 'Pipfile':
      return 'pipfile';
    case 'Gemfile':
      return 'gemfile';
  }
  if (/^(?:requirements|constraints)[\w.-]*\.txt$/.test(base) || /requirements\.txt$/.test(base))
    return 'pip';
  if (/(?:^|\/)requirements\/[^/]+\.txt$/.test(path)) return 'pip';
  return null;
}

interface Entry {
  name: string;
  version: string;
  label: string;
}

type Side = '+' | '-';

interface Collector {
  entries: { side: Side; entry: Entry }[];
  other: string[];
}

const VERSION_LIKE =
  /^(?:[\^~<>=*]|\d|v\d|workspace:|npm:|file:|link:|portal:|patch:|git\+|git:|github:|https?:\/\/|latest$|next$|beta$|canary$)/;

const NPM_SECTIONS: Record<string, string> = {
  dependencies: '',
  devDependencies: 'dev',
  peerDependencies: 'peer',
  optionalDependencies: 'optional',
  overrides: 'override',
  resolutions: 'override',
  require: '',
  'require-dev': 'dev',
};
const NPM_TOP_LEVEL_KEYS = new Set([
  'name',
  'version',
  'description',
  'main',
  'module',
  'types',
  'typings',
  'license',
  'private',
  'type',
  'homepage',
  'author',
  'packageManager',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'php',
]);
const TOML_META_KEYS = new Set([
  'name',
  'version',
  'description',
  'edition',
  'license',
  'readme',
  'authors',
  'requires-python',
  'rust-version',
  'homepage',
  'repository',
]);

/** Builds the summary for one manifest from its (already redacted) hunks. */
export function summarizeManifest(kind: ManifestKind, path: string, hunks: readonly Hunk[]): string {
  const col: Collector = { entries: [], other: [] };
  const fileLabel = kind === 'pip' && /(?:dev|test)/i.test(basename(path)) ? 'dev' : '';
  for (const hunk of hunks) {
    const lines = hunk.text.split('\n');
    switch (kind) {
      case 'npm':
      case 'composer':
        scanJson(lines, col);
        break;
      case 'go':
        scanGoMod(lines, col);
        break;
      case 'pip':
        scanRequirements(lines, col, fileLabel);
        break;
      case 'gemfile':
        scanGemfile(lines, col);
        break;
      default:
        scanToml(kind, lines, col);
    }
  }
  return render(kind, col);
}

function changed(line: string): Side | null {
  const c = line[0];
  return c === '+' || c === '-' ? c : null;
}

function pushOther(col: Collector, side: Side | null, content: string): void {
  if (!side) return;
  const t = content.trim();
  if (t === '') return;
  col.other.push(
    `${side}${t.length > MAX_OTHER_LINE_LENGTH ? `${t.slice(0, MAX_OTHER_LINE_LENGTH)}...` : t}`,
  );
}

function pushEntry(col: Collector, side: Side | null, entry: Entry): void {
  if (side) col.entries.push({ side, entry });
}

// ─────────────────────────── formats ───────────────────────────

function scanJson(lines: string[], col: Collector): void {
  // Stack of object keys from the hunk's own lines; `null` = we do not know (hunk began mid-object).
  const stack: (string | null)[] = [null];
  for (const line of lines) {
    const side = changed(line);
    const content = line.slice(1);
    const open = /^\s*"([^"]+)"\s*:\s*[{[]\s*$/.exec(content);
    if (open) {
      stack.push(open[1] as string);
      continue;
    }
    if (/^\s*[}\]]\s*,?\s*$/.test(content)) {
      stack.pop();
      if (stack.length === 0) stack.push(null);
      continue;
    }
    const entry = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/.exec(content);
    if (entry) {
      const [, key, value] = entry as unknown as [string, string, string];
      const section = stack[stack.length - 1] ?? null;
      const label = section === null ? undefined : NPM_SECTIONS[section];
      const isDep =
        section === null ? VERSION_LIKE.test(value) && !NPM_TOP_LEVEL_KEYS.has(key) : label !== undefined;
      if (isDep) {
        pushEntry(col, side, { name: key, version: value, label: label ?? '' });
        continue;
      }
    }
    pushOther(col, side, content);
  }
}

function scanGoMod(lines: string[], col: Collector): void {
  let block: string | null = null; // null = unknown or top level
  for (const line of lines) {
    const side = changed(line);
    const content = line.slice(1);
    const open = /^\s*(require|replace|exclude|retract)\s*\(\s*$/.exec(content);
    if (open) {
      block = open[1] as string;
      continue;
    }
    if (/^\s*\)\s*$/.test(content)) {
      block = null;
      continue;
    }
    const single = /^\s*require\s+(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?\s*$/.exec(content);
    const inBlock =
      block === 'require' || block === null
        ? /^\s*(\S+)\s+(v\d\S*)(\s*\/\/\s*indirect)?\s*$/.exec(content)
        : null;
    const m = single ?? inBlock;
    if (m) {
      pushEntry(col, side, { name: m[1] as string, version: m[2] as string, label: m[3] ? 'indirect' : '' });
      continue;
    }
    pushOther(col, side, content);
  }
}

const PEP508 =
  /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?)\s*((?:===|[<>=!~]=?)[^;#]*)?\s*(?:;[^#]*)?(?:#.*)?$/;

function parsePep508(spec: string, label: string): Entry | null {
  const m = PEP508.exec(spec.trim());
  if (!m) return null;
  return { name: m[1] as string, version: (m[2] ?? '').replace(/\s+/g, ''), label };
}

function scanRequirements(lines: string[], col: Collector, label: string): void {
  for (const line of lines) {
    const side = changed(line);
    const content = line.slice(1).trim();
    if (content === '' || content.startsWith('#')) continue;
    const entry = content.startsWith('-') ? null : parsePep508(content, label);
    if (entry) pushEntry(col, side, entry);
    else pushOther(col, side, content);
  }
}

function scanGemfile(lines: string[], col: Collector): void {
  let label = '';
  for (const line of lines) {
    const side = changed(line);
    const content = line.slice(1);
    const group = /^\s*group\s+(.+?)\s+do\s*$/.exec(content);
    if (group) {
      label = /development|test/.test(group[1] as string) ? 'dev' : '';
      continue;
    }
    if (/^\s*end\s*$/.test(content)) {
      label = '';
      continue;
    }
    const gem = /^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(content);
    if (gem) {
      pushEntry(col, side, { name: gem[1] as string, version: (gem[2] ?? '').replace(/\s+/g, ''), label });
      continue;
    }
    pushOther(col, side, content);
  }
}

/** Label for a TOML dependency table, or null when the section is not a dependency table. */
function tomlTableLabel(kind: ManifestKind, section: string | null): string | null {
  if (section === null) return null;
  if (kind === 'pipfile') return section === 'packages' ? '' : section === 'dev-packages' ? 'dev' : null;
  if (kind === 'cargo') {
    const m = /(?:^|\.)((?:dev-|build-)?)dependencies$/.exec(section);
    return m ? (m[1] as string).replace(/-$/, '') : null;
  }
  // pyproject (poetry)
  if (section === 'tool.poetry.dependencies') return '';
  if (section === 'tool.poetry.dev-dependencies') return 'dev';
  const group = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(section);
  return group ? (group[1] as string) : null;
}

/** Label for a PEP 621 / PEP 735 dependency array, or null. */
function tomlArrayLabel(section: string | null, key: string): string | null {
  if (section === 'project' && key === 'dependencies') return '';
  if (section === 'project.optional-dependencies') return 'optional';
  if (section === 'dependency-groups') return key;
  if (section === 'build-system' && key === 'requires') return 'build';
  if (section === null && (key === 'dependencies' || key === 'requires')) return '';
  return null;
}

function tomlVersion(value: string): string | null {
  const quoted = /^["']([^"']*)["']$/.exec(value);
  if (quoted) return quoted[1] as string;
  if (value.startsWith('{')) {
    const v = /\bversion\s*=\s*["']([^"']*)["']/.exec(value);
    if (v) return v[1] as string;
    if (/\bgit\s*=/.test(value)) return 'git';
    if (/\bpath\s*=/.test(value)) return 'path';
    if (/\bworkspace\s*=\s*true/.test(value)) return 'workspace';
    return '';
  }
  return null;
}

function scanToml(kind: ManifestKind, lines: string[], col: Collector): void {
  let section: string | null = null;
  let array: { label: string } | null = null;
  for (const line of lines) {
    const side = changed(line);
    const content = line.slice(1);
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(content);
    if (header) {
      section = (header[1] as string).replace(/["']/g, '');
      array = null;
      continue;
    }
    if (array) {
      if (/^\s*\]\s*,?\s*$/.test(content)) {
        array = null;
        continue;
      }
      const item = /^\s*["']([^"']+)["']\s*,?\s*(?:#.*)?$/.exec(content);
      const entry = item ? parsePep508(item[1] as string, array.label) : null;
      if (entry) pushEntry(col, side, entry);
      else pushOther(col, side, content);
      continue;
    }
    const arr = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\[(.*)$/.exec(content);
    if (arr) {
      const label = tomlArrayLabel(section, arr[1] as string);
      if (label !== null) {
        const rest = arr[2] as string;
        if (rest.includes(']')) {
          for (const m of rest.matchAll(/["']([^"']+)["']/g)) {
            const entry = parsePep508(m[1] as string, label);
            if (entry) pushEntry(col, side, entry);
          }
        } else {
          array = { label };
        }
        continue;
      }
    }
    const kv = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*(?:#[^"']*)?$/.exec(content);
    if (kv) {
      const key = kv[1] as string;
      const version = tomlVersion(kv[2] as string);
      const tableLabel = tomlTableLabel(kind, section);
      // `[dependencies.serde]` + `version = "1"`
      const dotted = section ? /(?:^|\.)((?:dev-|build-)?)dependencies\.([^.]+)$/.exec(section) : null;
      if (version !== null && dotted && key === 'version') {
        pushEntry(col, side, {
          name: dotted[2] as string,
          version,
          label: (dotted[1] as string).replace(/-$/, ''),
        });
        continue;
      }
      const unknownDep = section === null && version !== null && VERSION_LIKE.test(version);
      if (version !== null && (tableLabel !== null || (unknownDep && !TOML_META_KEYS.has(key)))) {
        pushEntry(col, side, { name: key, version, label: tableLabel ?? '' });
        continue;
      }
    }
    pushOther(col, side, content);
  }
}

// ─────────────────────────── rendering ───────────────────────────

function formatEntry(kind: ManifestKind, e: Entry): string {
  const label = e.label ? ` (${e.label})` : '';
  if (e.version === '') return `${e.name}${label}`;
  const pep = kind === 'pip' || (kind === 'pyproject' && /^[<>=!~]/.test(e.version));
  return `${pep ? `${e.name}${e.version}` : `${e.name}@${e.version}`}${label}`;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function render(kind: ManifestKind, col: Collector): string {
  const norm = (name: string) =>
    kind === 'pip' || kind === 'pyproject' ? name.toLowerCase().replace(/_/g, '-') : name;
  const added = new Map<string, Entry>();
  const removed = new Map<string, Entry>();
  for (const { side, entry } of col.entries) {
    const key = `${norm(entry.name)}\u0000${entry.label}`;
    (side === '+' ? added : removed).set(key, entry);
  }
  const addedOut: Entry[] = [];
  const removedOut: Entry[] = [];
  const changedOut: { name: string; label: string; from: string; to: string }[] = [];
  for (const [key, a] of added) {
    const r = removed.get(key);
    if (!r) addedOut.push(a);
    else if (r.version !== a.version)
      changedOut.push({ name: a.name, label: a.label, from: r.version || '*', to: a.version || '*' });
  }
  for (const [key, r] of removed) if (!added.has(key)) removedOut.push(r);

  const byName = (a: { name: string; label: string }, b: { name: string; label: string }) =>
    cmp(a.name, b.name) || cmp(a.label, b.label);
  addedOut.sort(byName);
  removedOut.sort(byName);
  changedOut.sort(byName);

  const parts: string[] = [];
  if (addedOut.length) parts.push(`added: ${addedOut.map((e) => formatEntry(kind, e)).join(', ')}`);
  if (removedOut.length) parts.push(`removed: ${removedOut.map((e) => formatEntry(kind, e)).join(', ')}`);
  if (changedOut.length) {
    const items = changedOut.map((c) => `${c.name} ${c.from} -> ${c.to}${c.label ? ` (${c.label})` : ''}`);
    parts.push(`changed: ${items.join(', ')}`);
  }
  if (col.other.length) {
    const shown = col.other.slice(0, MAX_OTHER_LINES);
    const more = col.other.length - shown.length;
    parts.push(`other: ${shown.join(' | ')}${more > 0 ? ` | (+${more} more)` : ''}`);
  }
  return parts.length > 0 ? parts.join('; ') : 'no dependency changes';
}
