/**
 * Loads web-tree-sitter and the vendored grammars (PRE-06). This is the ONLY place in the preprocess
 * module that performs I/O; it runs once inside `createPreprocessEngine`, never inside `run`.
 *
 * Grammar directory resolution works for both layouts:
 * - source / tests: `src/preprocess/ast/runtime.ts` → `src/preprocess/ast/grammars/`
 * - bundle:         `dist/action.js` / `dist/cli.js` → `dist/grammars/` (copied by scripts/build.mjs)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';
import { type AstLanguage, isAstLanguage } from './languages';

export const RUNTIME_WASM = 'web-tree-sitter.wasm';

const GRAMMAR_FILES: Record<AstLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
};

export interface AstRuntime {
  /** Ready parsers keyed by language. Missing languages fall back to ±20 line contexts. */
  parsers: Map<AstLanguage, Parser>;
  /** Grammar directory that was used, or null when none was found. */
  grammarDir: string | null;
  /** Load problems (file names / messages only, never content). */
  errors: string[];
  /** Requested languages whose grammar could not be loaded (PRE-06 `ast_failed` warnings). */
  failed: AstLanguage[];
}

/** Candidate grammar directories, in priority order. */
export function grammarDirCandidates(baseUrl: string = import.meta.url): string[] {
  return [fileURLToPath(new URL('./grammars/', baseUrl)), fileURLToPath(new URL('./ast/grammars/', baseUrl))];
}

export function resolveGrammarDir(candidates: readonly string[] = grammarDirCandidates()): string | null {
  for (const dir of candidates) {
    if (existsSync(join(dir, RUNTIME_WASM))) return dir;
  }
  return null;
}

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Language>>();

function initRuntime(dir: string): Promise<void> {
  if (!initPromise) {
    const wasmBinary = readFileSync(join(dir, RUNTIME_WASM));
    initPromise = Parser.init({
      wasmBinary,
      locateFile: (file: string) => join(dir, file),
    }).catch((err: unknown) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

function loadLanguage(file: string): Promise<Language> {
  let p = languageCache.get(file);
  if (!p) {
    p = Language.load(readFileSync(file));
    p.catch(() => languageCache.delete(file));
    languageCache.set(file, p);
  }
  return p;
}

/**
 * Loads parsers for `languages` (unknown names are ignored). Never throws: failures are reported
 * in `errors` and the affected languages use the line-window fallback.
 */
export async function loadAstRuntime(languages: readonly string[], grammarDir?: string): Promise<AstRuntime> {
  const runtime: AstRuntime = { parsers: new Map(), grammarDir: null, errors: [], failed: [] };
  const wanted = [...new Set(languages.filter(isAstLanguage))];
  if (wanted.length === 0) return runtime;
  const dir = grammarDir ?? resolveGrammarDir();
  if (!dir || !existsSync(join(dir, RUNTIME_WASM))) {
    runtime.errors.push(`grammar directory not found (${RUNTIME_WASM})`);
    runtime.failed = wanted;
    return runtime;
  }
  runtime.grammarDir = dir;
  try {
    await initRuntime(dir);
  } catch (err) {
    runtime.errors.push(`runtime init failed: ${errorMessage(err)}`);
    runtime.failed = wanted;
    return runtime;
  }
  for (const lang of wanted) {
    const file = join(dir, GRAMMAR_FILES[lang]);
    try {
      if (!existsSync(file)) throw new Error(`missing ${GRAMMAR_FILES[lang]}`);
      const language = await loadLanguage(file);
      const parser = new Parser();
      parser.setLanguage(language);
      runtime.parsers.set(lang, parser);
    } catch (err) {
      runtime.errors.push(`${lang}: ${errorMessage(err)}`);
      runtime.failed.push(lang);
    }
  }
  return runtime;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
