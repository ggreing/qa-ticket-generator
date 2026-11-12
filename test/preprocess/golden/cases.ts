/** All golden fixture sources. `fixtures/preprocess/*.json` is generated from these. */
import { astCases } from './cases-ast';
import { filterCases } from './cases-filter';
import { packCases } from './cases-pack';
import { redactCases } from './cases-redact';
import type { GoldenCase } from './types';

export const goldenCases: GoldenCase[] = [...filterCases, ...redactCases, ...astCases, ...packCases];

/** File name for a case: `PRE-05 AWS access keys` → `pre-05-aws-access-keys.json`. */
export function fixtureFileName(name: string): string {
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/, '')}.json`;
}
