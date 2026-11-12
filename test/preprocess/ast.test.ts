import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Parser } from 'web-tree-sitter';
import { engineFromRuntime } from '../../src/preprocess';
import { expandContexts, MAX_SYMBOL_LINES, omittedMarker } from '../../src/preprocess/ast/expand';
import { isAstLanguage, SUPPORTED_AST_LANGUAGES } from '../../src/preprocess/ast/languages';
import {
  type AstRuntime,
  grammarDirCandidates,
  loadAstRuntime,
  RUNTIME_WASM,
  resolveGrammarDir,
} from '../../src/preprocess/ast/runtime';
import { parsePatch } from '../../src/preprocess/diff';
import { ALL_AST_LANGUAGES, dedent, input, modified, unifiedDiff } from './helpers';

const GRAMMAR_DIR = resolveGrammarDir() as string;
const manifest = JSON.parse(readFileSync(join(GRAMMAR_DIR, 'manifest.json'), 'utf8')) as {
  runtime: { file: string; bytes: number; sha256: string; version: string };
  grammars: Record<string, { file: string; bytes: number; sha256: string }>;
};
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

let runtime: AstRuntime;
beforeAll(async () => {
  runtime = await loadAstRuntime(ALL_AST_LANGUAGES);
});

/** Contexts for a single modified file, through the real runtime. */
function contexts(path: string, oldText: string, newText: string) {
  const hunks = parsePatch(unifiedDiff(oldText, newText)).hunks;
  const language =
    SUPPORTED_AST_LANGUAGES.find((l) => runtime.parsers.has(l) && path.endsWith(extFor(l))) ?? null;
  return expandContexts({
    rawContent: newText,
    redactedLines: newText.split('\n'),
    hunks,
    language,
    parser: language ? (runtime.parsers.get(language) ?? null) : null,
  });
}
function extFor(l: string): string {
  return (
    { typescript: '.ts', tsx: '.tsx', javascript: '.js', python: '.py', java: '.java', go: '.go' }[l] ?? '.x'
  );
}
const pad = (n: number, make: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => make(i)).join('\n');

describe('PRE-06 grammar assets', () => {
  it('PRE-06 loads every supported grammar with the bundled runtime', () => {
    expect(runtime.errors).toEqual([]);
    expect([...runtime.parsers.keys()].sort()).toEqual([...ALL_AST_LANGUAGES].sort());
    expect(runtime.grammarDir).toBe(GRAMMAR_DIR);
  });

  it('PRE-06 vendored wasm files match manifest.json (size and sha256)', () => {
    for (const g of [manifest.runtime, ...Object.values(manifest.grammars)]) {
      const file = join(GRAMMAR_DIR, g.file);
      expect(statSync(file).size, g.file).toBe(g.bytes);
      expect(sha256(file), g.file).toBe(g.sha256);
    }
  });

  it('PRE-06 the vendored runtime wasm is identical to the installed web-tree-sitter (glue/wasm drift guard)', () => {
    const require = createRequire(import.meta.url);
    const installed = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
    const pkg = JSON.parse(readFileSync(join(installed, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe(manifest.runtime.version);
    expect(sha256(installed)).toBe(manifest.runtime.sha256);
  });

  it('PRE-06 grammar directory resolution works for src and dist layouts', () => {
    const bundle = pathToFileURL(join(tmpdir(), 'repo', 'dist', 'action.js')).href;
    expect(grammarDirCandidates(bundle)[0]).toBe(`${join(tmpdir(), 'repo', 'dist', 'grammars')}${sep}`);
    expect(resolveGrammarDir([join(tmpdir(), 'qtg-missing-dir'), GRAMMAR_DIR])).toBe(GRAMMAR_DIR);
    expect(resolveGrammarDir([join(tmpdir(), 'qtg-missing-dir')])).toBeNull();
  });
});

describe('PRE-06 runtime failures never throw', () => {
  let partial: string;
  beforeAll(() => {
    partial = mkdtempSync(join(tmpdir(), 'qtg-grammars-'));
    copyFileSync(join(GRAMMAR_DIR, RUNTIME_WASM), join(partial, RUNTIME_WASM));
    copyFileSync(join(GRAMMAR_DIR, 'tree-sitter-go.wasm'), join(partial, 'tree-sitter-go.wasm'));
  });
  afterAll(() => rmSync(partial, { recursive: true, force: true }));

  it('PRE-06 a missing grammar directory yields no parsers and an error', async () => {
    const r = await loadAstRuntime(['typescript'], join(tmpdir(), 'qtg-missing-dir'));
    expect(r.parsers.size).toBe(0);
    expect(r.errors[0]).toMatch(/grammar directory not found/);
  });

  it('PRE-06 a missing grammar file only disables that language', async () => {
    const r = await loadAstRuntime(['go', 'python'], partial);
    expect([...r.parsers.keys()]).toEqual(['go']);
    expect(r.errors).toEqual(['python: missing tree-sitter-python.wasm']);
  });

  it('PRE-06 unknown or empty language lists load nothing', async () => {
    expect((await loadAstRuntime([])).parsers.size).toBe(0);
    expect((await loadAstRuntime(['ruby', 'cobol'])).parsers.size).toBe(0);
    expect(isAstLanguage('ruby')).toBe(false);
  });

  it('PRE-06 a throwing parser falls back to ±20 line windows', () => {
    const broken = {
      parse: () => {
        throw new Error('boom');
      },
    } as unknown as Parser;
    const text = pad(60, (i) => `line ${i}`);
    const hunks = parsePatch(unifiedDiff(text, text.replace('line 30', 'line thirty'))).hunks;
    const r = expandContexts({
      rawContent: text,
      redactedLines: text.split('\n'),
      hunks,
      language: 'typescript',
      parser: broken,
    });
    expect(r.astFailed).toBe(true);
    expect(r.contexts).toEqual([
      { kind: 'lines', startLine: 11, endLine: 51, text: text.split('\n').slice(10, 51).join('\n') },
    ]);
  });

  it('PRE-06 an engine without parsers still produces line contexts', () => {
    const engine = engineFromRuntime({ parsers: new Map(), grammarDir: null, errors: ['x'], failed: [] });
    expect(engine.astErrors).toEqual(['x']);
    const text = pad(60, (i) => `const v${i} = ${i};`);
    const out = engine.run(input([modified('src/a.ts', text, text.replace('v30 = 30', 'v30 = 31'))]));
    expect(out.chunks[0]?.files[0]?.contexts.map((c) => c.kind)).toEqual(['lines']);
  });

  it('PRE-06 empty contents or no changed lines produce no contexts', () => {
    expect(
      expandContexts({ rawContent: '', redactedLines: [], hunks: [], language: null, parser: null }).contexts,
    ).toEqual([]);
    expect(
      expandContexts({ rawContent: 'a', redactedLines: ['a'], hunks: [], language: null, parser: null })
        .contexts,
    ).toEqual([]);
  });
});

describe('PRE-06 symbol selection', () => {
  it('PRE-06 TS: class field arrow functions, object methods, default exports and interfaces', () => {
    const body = (name: string) => pad(12, (i) => `    const ${name}${i} = ${i};`);
    const oldText = dedent(`
      export class Store {
        reload = async () => {
      ${body('a')}
          await fetch('/a');
        };
      }
      const api = {
        load() {
      ${body('b')}
          return 1;
        },
      };
      export default function () {
      ${body('c')}
        return 2;
      }
      export interface Shape {
      ${pad(12, (i) => `  f${i}: string;`)}
        area: number;
      }
    `);
    const newText = oldText
      .replace("await fetch('/a');", "await fetch('/b');")
      .replace('return 1;', 'return 11;')
      .replace('return 2;', 'return 22;')
      .replace('area: number;', 'area: bigint;');
    const names = contexts('src/x.ts', oldText, newText).contexts.map((c) => c.name);
    expect(names).toEqual(['Store.reload', 'load', 'default', 'Shape']);
  });

  it('PRE-06 the nearest NAMED symbol wins over small anonymous callbacks', () => {
    const oldText = dedent(`
      export function total(items: number[]): number {
      ${pad(12, (i) => `  const t${i} = ${i};`)}
        return items.map((x) => x * 2).reduce((a, b) => a + b, 0);
      }
    `);
    const newText = oldText.replace('x * 2', 'x * 3');
    expect(contexts('src/t.ts', oldText, newText).contexts.map((c) => c.name)).toEqual(['total']);
  });

  it('PRE-06 Go: a grouped type declaration narrows to the type_spec; top-level func literals are anonymous', () => {
    const oldText = dedent(`
      package x

      type (
      \tA struct {
      ${pad(12, (i) => `\t\tF${i} int`)}
      \t\tName string
      \t}
      \tB int
      )

      var handler = func() {
      ${pad(12, (i) => `\tprintln(${i})`)}
      \tprintln("done")
      }
    `);
    const newText = oldText
      .replace('\t\tName string', '\t\tName []byte')
      .replace('println("done")', 'println("ok")');
    const out = contexts('x/x.go', oldText, newText).contexts;
    expect(out.map((c) => [c.name, c.startLine])).toEqual([
      ['A', 4],
      [undefined, 22],
    ]);
  });

  it('PRE-06 class-level changes spanning two methods resolve line by line', () => {
    const method = (n: string) => `  ${n}() {\n${pad(10, (i) => `    this.${n}${i}();`)}\n  }`;
    const oldText = `class K {\n${method('a')}\n${method('b')}\n}`;
    const lines = oldText.split('\n');
    // Change the last line of a() and the first body line of b() in one block.
    lines[10] = '    this.a9x();';
    lines[13] = '    this.b0x();';
    const out = contexts('k.js', oldText, lines.join('\n')).contexts;
    expect(out.map((c) => c.name)).toEqual(['K']);
    expect(out[0]?.endLine).toBe(25);
  });

  it(`PRE-06 a symbol of exactly ${MAX_SYMBOL_LINES} lines is kept whole; one more line is truncated`, () => {
    const make = (n: number) => `function f() {\n${pad(n - 2, (i) => `  s(${i});`)}\n}\n`;
    const whole = contexts(
      'a.js',
      make(MAX_SYMBOL_LINES),
      make(MAX_SYMBOL_LINES).replace('s(150);', 's(150, 1);'),
    );
    expect(whole.contexts[0]?.text.split('\n')).toHaveLength(MAX_SYMBOL_LINES);
    const cut = contexts(
      'a.js',
      make(MAX_SYMBOL_LINES + 1),
      make(MAX_SYMBOL_LINES + 1).replace('s(150);', 's(150, 1);'),
    );
    expect(cut.contexts[0]?.text).toContain(omittedMarker(130));
  });
});
