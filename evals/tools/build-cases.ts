/** Writes `evals/cases/<id>/*.json` and `evals/splits.json` from the authored cases. Run via `npm run eval:build-cases`. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildCase } from '../authoring/build';
import { CASES } from '../authoring/index';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Regenerates every case directory under `casesRoot` plus the split file next to it; returns the case ids. */
export function writeCases(casesRoot: string): string[] {
  const built = CASES.map(buildCase);
  for (const c of built) {
    const dir = join(casesRoot, c.id);
    mkdirSync(join(dir, 'prd'), { recursive: true });
    writeFileSync(join(dir, 'pr.json'), json(c.pr));
    writeFileSync(join(dir, 'files.json'), json(c.files));
    writeFileSync(join(dir, 'expected.json'), json(c.expected));
    for (const { name, doc } of c.prd) writeFileSync(join(dir, 'prd', `${name}.json`), json(doc));
    if (c.options) writeFileSync(join(dir, 'options.json'), json(c.options));
    else rmSync(join(dir, 'options.json'), { force: true });
  }
  const ids = (split: string): string[] =>
    built
      .filter((c) => c.split === split)
      .map((c) => c.id)
      .sort();
  writeFileSync(join(dirname(casesRoot), 'splits.json'), json({ dev: ids('dev'), test: ids('test') }));
  return built.map((c) => c.id);
}
