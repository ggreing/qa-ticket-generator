/** Synthetic large PR for the PRE-01 performance test: 300 files, > 2MB of patches. */
import type { ChangedFile, PreprocessInput } from '../../src/core/contracts';
import { file, hunk, input, prd, rng } from './helpers';

const WORDS = [
  'coupon',
  'cart',
  'order',
  'refund',
  'invoice',
  'ledger',
  'price',
  'discount',
  'user',
  'session',
];
const FUNCTIONS = 30;
const BODY = 12;

/** A TS module of 30 functions; every other function gets one edited and six added lines. */
function tsFile(path: string, rand: () => number, withSecret: boolean): ChangedFile {
  const oldLines: string[] = ["import { db } from './db';", ''];
  const starts: number[] = [];
  for (let f = 0; f < FUNCTIONS; f++) {
    const w = WORDS[Math.floor(rand() * WORDS.length)];
    starts.push(oldLines.length);
    oldLines.push(`export async function ${w}Handler${f}(id: string, amount: number): Promise<number> {`);
    for (let i = 0; i < BODY; i++)
      oldLines.push(`  const ${w}${i} = await db.${w}.find({ id, step: ${i}, amount });`);
    oldLines.push(`  return ${w}0.total + amount * ${f};`, '}', '');
  }
  const newLines: string[] = [];
  const hunks: string[] = [];
  let cursor = 0;
  for (let f = 0; f < FUNCTIONS; f += 2) {
    const edit = (starts[f] as number) + 6; // a line in the middle of the body
    newLines.push(...oldLines.slice(cursor, edit - 3));
    const before = oldLines.slice(edit - 3, edit);
    const old = oldLines[edit] as string;
    const after = oldLines.slice(edit + 1, edit + 4);
    const replaced = old.replace('find(', 'findOne(');
    const added = Array.from({ length: 6 }, (_, k) =>
      withSecret && f === 0 && k === 0
        ? '  const password = "hunter2!x";'
        : `  audit(${k}, "${WORDS[k]}", amount);`,
    );
    const newStart = newLines.length + 1;
    hunks.push(
      hunk(edit - 2, newStart, [
        ...before.map((l) => ` ${l}`),
        `-${old}`,
        `+${replaced}`,
        ...added.map((l) => `+${l}`),
        ...after.map((l) => ` ${l}`),
      ]),
    );
    newLines.push(...before, replaced, ...added, ...after);
    cursor = edit + 4;
  }
  newLines.push(...oldLines.slice(cursor));
  return file(path, hunks.join('\n'), { headContent: newLines.join('\n') });
}

export function largeInput(): { input: PreprocessInput; patchBytes: number } {
  const rand = rng(7);
  const files: ChangedFile[] = [];
  for (let i = 0; i < 300; i++) {
    const kind = i % 2 === 0 ? 0 : 1 + (i % 3);
    const dir = `src/${WORDS[i % WORDS.length]}/${['api', 'domain', 'ui'][i % 3]}`;
    if (kind === 0) {
      files.push(tsFile(`${dir}/m${i}.ts`, rand, i % 20 === 0));
    } else if (kind === 1) {
      const body = Array.from(
        { length: 150 },
        (_, k) => `+    ${WORDS[k % 10]}_${k} = await svc.call(${k})  # step`,
      );
      files.push(file(`${dir}/m${i}.py`, hunk(10, 10, ['     def handler(self):', ...body])));
    } else if (kind === 2) {
      const body = Array.from(
        { length: 150 },
        (_, k) => `+\t${WORDS[k % 10]}${k}, err := svc.Call(ctx, ${k})`,
      );
      files.push(
        file(`${dir}/m${i}.go`, hunk(10, 10, [' func Handle(ctx context.Context) error {', ...body])),
      );
    } else {
      const body = Array.from(
        { length: 120 },
        (_, k) => `+- The ${WORDS[k % 10]} flow must handle case ${k} gracefully.`,
      );
      files.push(file(`docs/${WORDS[i % 10]}/m${i}.md`, hunk(1, 1, body)));
    }
  }
  const patchBytes = files.reduce((s, f) => s + (f.patch?.length ?? 0), 0);
  return {
    input: input(files, [
      prd('1', 'Coupon refunds', 'Refund flow for coupon orders.', [
        'Refunds restore the coupon',
        'Ledger is updated',
      ]),
    ]),
    patchBytes,
  };
}
