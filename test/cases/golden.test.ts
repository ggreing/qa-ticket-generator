/**
 * Golden fixtures for the case engine (SPEC v3 §3.1, §4): `fixtures/cases/*.json` holds
 * { name, kind, input, expected } and pins reconcile, planSync, lint and render behaviour.
 *
 * Regenerate after an intentional change, then review the diff:
 *   UPDATE_GOLDEN=1 npx vitest run test/cases/golden.test.ts
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyVerify, lintCaseStyle, planSync, reconcileCases, renderCase } from '../../src/cases';
import type { Language } from '../../src/core/contracts';
import { ALL_SOURCES, fixtureFileName, type GoldenSource } from './golden/sources';

const DIR = fileURLToPath(new URL('../../fixtures/cases/', import.meta.url));
const UPDATE = Boolean(process.env.UPDATE_GOLDEN);
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function run(kind: GoldenSource['kind'], input: unknown): unknown {
  switch (kind) {
    case 'reconcile': {
      const i = input as Extract<GoldenSource, { kind: 'reconcile' }>['input'];
      return reconcileCases(i.specRef, i.existing, i.planned);
    }
    case 'sync': {
      const i = input as Extract<GoldenSource, { kind: 'sync' }>['input'];
      const ops = planSync(i.existing, i.next, (c) => renderCase(c, i.language as Language));
      // Compact form: which op for which case / ticket.
      return ops.map((o) => ({
        op: o.op,
        caseId: 'case' in o ? o.case.caseId : o.ticket.caseId,
        ticketRef: 'ticket' in o ? o.ticket.ticketRef : null,
      }));
    }
    case 'lint': {
      const i = input as Extract<GoldenSource, { kind: 'lint' }>['input'];
      return lintCaseStyle(i.case, i.language);
    }
    case 'render': {
      const i = input as Extract<GoldenSource, { kind: 'render' }>['input'];
      return renderCase(i.case, i.language);
    }
    case 'verify': {
      const i = input as Extract<GoldenSource, { kind: 'verify' }>['input'];
      return applyVerify(i.cases, i.result, i.sha, i.specRef);
    }
  }
}

if (UPDATE) {
  it('SPEC v3 §4 regenerates case-engine golden fixtures', () => {
    mkdirSync(DIR, { recursive: true });
    for (const f of readdirSync(DIR)) if (f.endsWith('.json')) rmSync(join(DIR, f));
    for (const s of ALL_SOURCES) {
      const fixture = {
        name: s.name,
        kind: s.kind,
        input: roundTrip(s.input),
        expected: roundTrip(run(s.kind, s.input)),
      };
      writeFileSync(join(DIR, fixtureFileName(s)), `${JSON.stringify(fixture, null, 2)}\n`);
    }
  });
}

mkdirSync(DIR, { recursive: true });
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe.skipIf(UPDATE)('SPEC v3 §4 case-engine golden fixtures', () => {
  it('SPEC v3 §4 fixtures match their sources one to one', () => {
    const names = ALL_SOURCES.map(fixtureFileName);
    expect(new Set(names).size).toBe(names.length);
    expect(files).toEqual([...names].sort());
    for (const s of ALL_SOURCES) {
      const f = JSON.parse(readFileSync(join(DIR, fixtureFileName(s)), 'utf8'));
      expect(f.name).toBe(s.name);
      expect(f.input).toStrictEqual(roundTrip(s.input));
    }
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as {
      name: string;
      kind: GoldenSource['kind'];
      input: unknown;
      expected: unknown;
    };
    it(`${fixture.name} (${file})`, () => {
      expect(roundTrip(run(fixture.kind, fixture.input))).toStrictEqual(fixture.expected);
    });
  }
});
