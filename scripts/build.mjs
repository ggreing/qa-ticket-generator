// Bundles the Action and CLI entry points into dist/ (single-file ESM, Node 24).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Some dependencies still call require(); give the ESM bundle a real one.
const banner = {
  js: "import { createRequire as __qtgCreateRequire } from 'node:module'; const require = __qtgCreateRequire(import.meta.url);",
};

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const common = {
  define: { __QTG_VERSION__: JSON.stringify(version) },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'external',
  banner,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [join(root, 'src/adapters/action.ts')],
  outfile: join(dist, 'action.js'),
});
await build({
  ...common,
  entryPoints: [join(root, 'src/adapters/cli.ts')],
  outfile: join(dist, 'cli.js'),
  banner: { js: `#!/usr/bin/env node\n${banner.js}` },
});

// Tree-sitter WASM assets (runtime + grammars) are loaded from dist/grammars at runtime (PRE-06).
const grammarSrc = join(root, 'src/preprocess/ast/grammars');
if (existsSync(grammarSrc) && readdirSync(grammarSrc).some((f) => f.endsWith('.wasm'))) {
  cpSync(grammarSrc, join(dist, 'grammars'), { recursive: true });
}
