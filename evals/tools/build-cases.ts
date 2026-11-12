/** Writes `evals/cases/<id>/*.json` from the authored cases. Run via `node evals/cli.mjs build-cases`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCase } from '../authoring/build';
import { CASES } from '../authoring/index';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Regenerates every case directory under `casesRoot` and returns the case ids. */
export function writeCases(casesRoot: string): string[] {
  return CASES.map((def) => {
    const built = buildCase(def);
    const dir = join(casesRoot, built.id);
    mkdirSync(join(dir, 'prd'), { recursive: true });
    writeFileSync(join(dir, 'pr.json'), json(built.pr));
    writeFileSync(join(dir, 'files.json'), json(built.files));
    writeFileSync(join(dir, 'expected.json'), json(built.expected));
    for (const { name, doc } of built.prd) writeFileSync(join(dir, 'prd', `${name}.json`), json(doc));
    return built.id;
  });
}
