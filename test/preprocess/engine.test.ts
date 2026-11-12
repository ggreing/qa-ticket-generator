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

/**
 * PRE-01 performance target: run() under 1s for 300 files / ~2MB of diff. The benchmark always
 * runs and prints its result; the test only FAILS above PERF_LIMIT_MS, so shared 2-core CI runners
 * and parallel local test runs do not flake. `QTG_PERF=1` enforces the 1s target strictly.
 */
const PERF_TARGET_MS = 1_000;
const PERF_STRICT = process.env.QTG_PERF === '1';
const PERF_LIMIT_MS = PERF_STRICT ? PERF_TARGET_MS : 4_000;

/** Best of `rounds` timed runs after one warm-up run (JIT). */
function benchmark(run: () => void, rounds = 3): { best: number; times: number[] } {
  run();
  const times: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  return { best: Math.min(...times), times };
}

describe('PRE-01 performance', () => {
  it('PRE-01 benchmarks 300 files / ~2MB of diff against the 1s target', () => {
    const { input: big, patchBytes } = largeInput();
    expect(big.files).toHaveLength(300);
    expect(patchBytes).toBeGreaterThan(2_000_000);

    let out = engine.run(big);
    const { best, times } = benchmark(() => {
      out = engine.run(big);
    });
    const summary =
      `300 files / ${(patchBytes / 1e6).toFixed(2)}MB patches: best ${best.toFixed(0)}ms ` +
      `(runs ${times.map((t) => t.toFixed(0)).join(', ')}ms; target ${PERF_TARGET_MS}ms, ` +
      `fail limit ${PERF_LIMIT_MS}ms${PERF_STRICT ? ', QTG_PERF=1' : ''})`;
    console.info(`[perf] ${summary}${best > PERF_TARGET_MS ? ' -- above the 1s target' : ''}`);
    expect(best, `PRE-01 performance: ${summary}`).toBeLessThan(PERF_LIMIT_MS);
    expect(out.mode).toBe('map_reduce');
    expect(out.redactions.find((r) => r.type === 'password')?.count).toBeGreaterThan(0);
    expect(out.chunks.flatMap((c) => c.files).some((f) => f.contexts.some((x) => x.kind === 'symbol'))).toBe(
      true,
    );
  }, 120_000);
});
