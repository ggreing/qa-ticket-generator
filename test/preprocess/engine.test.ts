import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PreprocessEngine } from '../../src/core/contracts';
import { createPreprocessEngine } from '../../src/preprocess';
import { loadAstRuntime } from '../../src/preprocess/ast/runtime';
import { MAX_AST_PARSE_CHARS, runPreprocess } from '../../src/preprocess/engine';
import { goldenCases } from './golden/cases';
import { ALL_AST_LANGUAGES, input, modified } from './helpers';
import { largeInput } from './large-input';

const SRC = fileURLToPath(new URL('../../src/preprocess/', import.meta.url));
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

let engine: PreprocessEngine;
beforeAll(async () => {
  engine = await createPreprocessEngine({ astLanguages: ALL_AST_LANGUAGES });
});

describe('PRE-01 pure, deterministic engine', () => {
  it('PRE-01 same input → same output, independent of file order', () => {
    for (const c of goldenCases) {
      const a = engine.run(c.input);
      const b = engine.run({ ...c.input, files: [...c.input.files].reverse() });
      expect(b, c.name).toStrictEqual(a);
    }
  });

  it('PRE-01 does not mutate its input and returns JSON-serializable output', () => {
    for (const c of goldenCases) {
      const before = roundTrip(c.input);
      const out = engine.run(c.input);
      expect(c.input, c.name).toStrictEqual(before);
      expect(roundTrip(out), c.name).toStrictEqual(out);
    }
  });

  it('PRE-01 run uses no clock, randomness, network or environment', () => {
    const boom = () => {
      throw new Error('impure call');
    };
    const spies = [
      vi.spyOn(Date, 'now').mockImplementation(boom),
      vi.spyOn(Math, 'random').mockImplementation(boom),
      vi.spyOn(globalThis, 'fetch').mockImplementation(boom),
      vi.spyOn(performance, 'now').mockImplementation(boom),
    ];
    const env = process.env;
    process.env = new Proxy({}, { get: boom, has: boom, ownKeys: boom }) as NodeJS.ProcessEnv;
    try {
      for (const c of goldenCases) engine.run(c.input);
    } finally {
      process.env = env;
      for (const s of spies) s.mockRestore();
    }
  });

  it('PRE-01 modules on the run() path import no I/O or nondeterministic APIs', () => {
    // ast/runtime.ts (factory-only loader) and index.ts (factory) are the only I/O modules.
    const runPath = ['', 'ast/']
      .flatMap((d) => readdirSync(join(SRC, d)).map((f) => `${d}${f}`))
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'ast/runtime.ts');
    expect(runPath.length).toBeGreaterThanOrEqual(10);
    for (const f of runPath) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, f).not.toMatch(
        /from 'node:|require\(|\bDate\b|Math\.random|process\.|fetch\(|performance\./,
      );
    }
  });
});

describe('PRE-06 AST parse budget', () => {
  it('PRE-06 parses the highest-scored files first and falls back to line windows past the cap', async () => {
    const ast = await loadAstRuntime(['typescript']);
    const body = (n: number) =>
      `export function f() {\n${Array.from({ length: 40 }, (_, i) => `  step(${i});`).join('\n')}\n}\n`.replace(
        'step(20);',
        `step(20, ${n});`,
      );
    const old = body(0);
    // high.ts changes more lines → higher score → parsed first; low.ts exceeds the remaining cap.
    const high = modified('src/high.ts', old, body(1).replace('step(10);', 'step(10, 1);'));
    const low = modified('src/low.ts', old, body(2));
    const out = runPreprocess(input([low, high]), ast, { maxAstParseChars: old.length + 10 });
    const kinds = Object.fromEntries(
      out.chunks[0]?.files.map((f) => [f.path, f.contexts.map((c) => c.kind)]) ?? [],
    );
    expect(kinds).toEqual({ 'src/high.ts': ['symbol'], 'src/low.ts': ['lines'] });
    expect(MAX_AST_PARSE_CHARS).toBe(2_000_000);
  });
});

// ─────────────────────────── performance ───────────────────────────

describe('PRE-01 performance', () => {
  it('PRE-01 runs 300 files / ~2MB of diff in under 1 second', () => {
    const { input: big, patchBytes } = largeInput();
    expect(big.files).toHaveLength(300);
    expect(patchBytes).toBeGreaterThan(2_000_000);

    let out = engine.run(big); // warm-up (JIT)
    const times: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      out = engine.run(big);
      times.push(performance.now() - t0);
    }
    const best = Math.min(...times);
    console.info(
      `[perf] preprocess 300 files / ${(patchBytes / 1e6).toFixed(2)}MB patches: best ${best.toFixed(0)}ms (${times.map((t) => t.toFixed(0)).join(', ')})`,
    );
    expect(best).toBeLessThan(1000);
    expect(out.mode).toBe('map_reduce');
    expect(out.redactions.find((r) => r.type === 'password')?.count).toBeGreaterThan(0);
    expect(out.chunks.flatMap((c) => c.files).some((f) => f.contexts.some((x) => x.kind === 'symbol'))).toBe(
      true,
    );
  });
});
