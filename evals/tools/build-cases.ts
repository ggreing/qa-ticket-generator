/**
 * Writes `evals/cases/<id>/*.json`, `evals/splits.json` and the case list `evals/CASES.md` from the
 * authored cases. Run via `npm run eval:build-cases`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type BuiltCase, buildCase } from '../authoring/build';
import { CASES } from '../authoring/index';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** `evals/CASES.md`: one row per synthetic case. People read it; the model never sees it. */
export function renderCaseTable(built: BuiltCase[]): string {
  const rows = [...built]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const sources = [...new Set(c.prd.map((p) => p.doc.ref.source))].sort().join(', ') || 'none';
      return `| ${[
        `\`${c.id}\``,
        c.split,
        c.files.length,
        sources,
        c.options ? `budget ${c.options.tokenBudget}` : 'default',
        c.expected.expectedAlignment,
        cell(c.expected.tags.join(', ')),
        cell(c.expected.notes),
      ].join(' | ')} |`;
    });
  return [
    '# Synthetic eval cases',
    '',
    'Generated from `evals/authoring/` by `npm run eval:build-cases`. Do not edit by hand.',
    'The last column says what was planted; it is never shown to the model or to the rubric judge.',
    '',
    '| Case | Split | Files | PRD | Preprocess | Expected | Tags | Planted |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/** Regenerates every case directory under `casesRoot` plus the split file and case list next to it; returns the case ids. */
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
  writeFileSync(join(dirname(casesRoot), 'CASES.md'), renderCaseTable(built));
  return built.map((c) => c.id);
}
