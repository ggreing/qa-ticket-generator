/**
 * PRE-06 — the grammar path resolution must work from the esbuild bundle too: scripts/build.mjs
 * bundles into `dist/*.js` and copies `src/preprocess/ast/grammars` to `dist/grammars`. This test
 * reproduces that layout in a temp dir and runs the engine in a separate Node process.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { ALL_AST_LANGUAGES, dedent, input, modified } from './helpers';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'qtg-bundle-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('PRE-06 bundled engine', () => {
  it('PRE-06 loads grammars from dist/grammars and expands symbols from the bundle', async () => {
    const dist = join(work, 'dist');
    await build({
      entryPoints: [join(ROOT, 'src/preprocess/index.ts')],
      outfile: join(dist, 'action.js'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as __qtgCreateRequire } from 'node:module'; const require = __qtgCreateRequire(import.meta.url);",
      },
    });
    cpSync(join(ROOT, 'src/preprocess/ast/grammars'), join(dist, 'grammars'), { recursive: true });

    const oldText = dedent(`
      export function total(items: number[]): number {
        let sum = 0;
        for (const i of items) sum += i;
        const a = 1;
        const b = 2;
        const c = 3;
        const d = 4;
        const e = 5;
        return sum;
      }
    `);
    const data = input([
      modified('src/total.ts', oldText, oldText.replace('return sum;', 'return Math.round(sum);')),
    ]);
    writeFileSync(join(work, 'input.json'), JSON.stringify(data));
    writeFileSync(
      join(work, 'run.mjs'),
      [
        "import { readFileSync } from 'node:fs';",
        "import { createPreprocessEngine } from './dist/action.js';",
        `const engine = await createPreprocessEngine({ astLanguages: ${JSON.stringify(ALL_AST_LANGUAGES)} });`,
        "const out = engine.run(JSON.parse(readFileSync(new URL('./input.json', import.meta.url), 'utf8')));",
        'console.log(JSON.stringify({ languages: engine.astLanguages, errors: engine.astErrors, out }));',
      ].join('\n'),
    );
    const stdout = execFileSync(process.execPath, [join(work, 'run.mjs')], { encoding: 'utf8', cwd: work });
    const result = JSON.parse(stdout) as {
      languages: string[];
      errors: string[];
      out: { chunks: { files: { contexts: { kind: string; name?: string }[] }[] }[] };
    };
    expect(result.errors).toEqual([]);
    expect([...result.languages].sort()).toEqual([...ALL_AST_LANGUAGES].sort());
    expect(result.out.chunks[0]?.files[0]?.contexts).toMatchObject([{ kind: 'symbol', name: 'total' }]);
  }, 60_000);
});
