/**
 * PRE-10 — golden fixture runner. `fixtures/preprocess/*.json` ({ name, input, expected }) is the
 * behavioural spec shared with any future (Rust/WASM) implementation.
 *
 * Regenerate after an intentional behaviour change, then review the diff:
 *   UPDATE_GOLDEN=1 npx vitest run test/preprocess/golden.test.ts
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PreprocessEngine, PreprocessInput, PreprocessOutput } from '../../src/core/contracts';
import { createPreprocessEngine } from '../../src/preprocess';
import { fixtureFileName, goldenCases } from './golden/cases';
import { ALL_AST_LANGUAGES } from './helpers';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/preprocess/', import.meta.url));
const UPDATE = Boolean(process.env.UPDATE_GOLDEN);

interface Fixture {
  name: string;
  input: PreprocessInput;
  expected: PreprocessOutput;
}

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

let engine: PreprocessEngine;
beforeAll(async () => {
  engine = await createPreprocessEngine({ astLanguages: ALL_AST_LANGUAGES });
});

if (UPDATE) {
  it('PRE-10 regenerates golden fixtures', () => {
    // Remove only generated fixtures (stale names included); keep README and other files.
    mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const f of readdirSync(FIXTURE_DIR)) if (f.endsWith('.json')) rmSync(join(FIXTURE_DIR, f));
    for (const c of goldenCases) {
      const fixture: Fixture = {
        name: c.name,
        input: roundTrip(c.input),
        expected: roundTrip(engine.run(c.input)),
      };
      writeFileSync(join(FIXTURE_DIR, fixtureFileName(c.name)), `${JSON.stringify(fixture, null, 2)}\n`);
    }
  });
}

mkdirSync(FIXTURE_DIR, { recursive: true });
const fixtureFiles = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
const fixtures = fixtureFiles.map((f) => ({
  file: f,
  fixture: JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture,
}));

describe.skipIf(UPDATE)('PRE-10 golden fixtures', () => {
  it('PRE-10 has at least 30 fixtures, one per case source, with matching inputs', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    expect(fixtureFiles).toEqual(goldenCases.map((c) => fixtureFileName(c.name)).sort());
    for (const c of goldenCases) {
      const f = fixtures.find((x) => x.file === fixtureFileName(c.name));
      expect(f?.fixture.name).toBe(c.name);
      expect(f?.fixture.input).toStrictEqual(roundTrip(c.input));
    }
  });

  for (const { file, fixture } of fixtures) {
    it(`${fixture.name} (${file})`, () => {
      const out = engine.run(fixture.input);
      expect(roundTrip(out)).toStrictEqual(fixture.expected);
    });
  }
});
