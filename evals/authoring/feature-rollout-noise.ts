import type { AuthoredCase } from './build';

/** Multi-file PR where half of the files are noise: tests, a snapshot, a lockfile and tsconfig. */
export const featureRolloutNoise: AuthoredCase = {
  id: 'feature-rollout-noise',
  pr: {
    number: 2011,
    title: 'Percentage rollouts for feature flags',
    author: 'nadia',
    headRef: 'feat/flag-rollout',
    body: `
Closes #1911

Flags get a rolloutPercent. Users are bucketed by an FNV-1a hash of flag key and user id, so the
same user keeps the same answer. Flag definitions are cached in memory for 60 seconds.
Also upgrades vitest and enables strict mode in tsconfig.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#1911',
      url: 'https://github.com/acme/shop/issues/1911',
      title: 'Gradual rollouts for feature flags',
      acceptanceCriteria: [
        'AC1: A user’s bucket comes from a stable hash of the flag key and the user id, so the same user always gets the same result for the same flag.',
        'AC2: A rollout of 0% enables the flag for nobody and a rollout of 100% enables it for every user.',
        'AC3: Flag definitions are cached for at most 60 seconds, so a change reaches every server within a minute.',
        'AC4: Every change of a rollout percentage is written to the audit log with the old value, the new value and the actor.',
      ],
      body: `
Flags are on/off for everyone today, so every launch is a big bang.

### Acceptance Criteria
- AC1: A user’s bucket comes from a stable hash of the flag key and the user id, so the same user always gets the same result for the same flag.
- AC2: A rollout of 0% enables the flag for nobody and a rollout of 100% enables it for every user.
- AC3: Flag definitions are cached for at most 60 seconds, so a change reaches every server within a minute.
- AC4: Every change of a rollout percentage is written to the audit log with the old value, the new value and the actor.
`,
    },
  ],
  files: [
    {
      path: 'src/flags/bucket.ts',
      content: `
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a. */
export function fnv1a(input: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** The user's bucket for a flag, from 1 to 100. */
export function bucketOf(flagKey: string, userId: string): number {
  return (fnv1a(\`\${flagKey}:\${userId}\`) % 100) + 1;
}
`,
    },
    {
      path: 'src/flags/evaluate.ts',
      content: `
import { bucketOf } from './bucket';
import type { FlagCache } from './cache';

export interface Flag {
  key: string;
  enabled: boolean;
  /** 0 to 100. */
  rolloutPercent: number;
}

export async function isEnabled(cache: FlagCache, flagKey: string, userId: string): Promise<boolean> {
  const flag = await cache.get(flagKey);
  if (!flag || !flag.enabled) return false;
  return bucketOf(flag.key, userId) < flag.rolloutPercent;
}
`,
    },
    {
      path: 'src/flags/cache.ts',
      content: `
import type { Flag } from './evaluate';

export const FLAG_CACHE_TTL_MS = 60_000;

export interface FlagSource {
  load(key: string): Promise<Flag | null>;
}

export class FlagCache {
  private readonly entries = new Map<string, { flag: Flag | null; loadedAt: number }>();

  constructor(
    private readonly source: FlagSource,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<Flag | null> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.loadedAt < FLAG_CACHE_TTL_MS) return hit.flag;
    const flag = await this.source.load(key);
    this.entries.set(key, { flag, loadedAt: this.now() });
    return flag;
  }
}
`,
    },
    {
      path: 'src/flags/admin.ts',
      diff: `
 import type { FlagRepository } from './repository';

 export class FlagAdmin {
   constructor(private readonly flags: FlagRepository) {}

   async setEnabled(key: string, enabled: boolean): Promise<void> {
     const flag = await this.flags.get(key);
     await this.flags.save({ ...flag, enabled });
   }
+
+  async setRollout(key: string, percent: number, actorId: string): Promise<void> {
+    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
+      throw new RangeError('rollout percent must be an integer from 0 to 100');
+    }
+    const flag = await this.flags.get(key);
+    await this.flags.save({ ...flag, rolloutPercent: percent, updatedBy: actorId });
+  }
 }
`,
    },
    {
      path: 'src/flags/__tests__/bucket.test.ts',
      content: `
import { describe, expect, it } from 'vitest';
import { bucketOf } from '../bucket';

describe('bucketOf', () => {
  it('is stable for the same flag and user', () => {
    expect(bucketOf('new-checkout', 'u-1')).toBe(bucketOf('new-checkout', 'u-1'));
  });

  it('stays within 1..100', () => {
    for (let i = 0; i < 1000; i++) {
      const b = bucketOf('f', \`u-\${i}\`);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(100);
    }
  });
});
`,
    },
    {
      path: 'src/flags/__tests__/__snapshots__/evaluate.test.ts.snap',
      content: `
// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html

exports[\`isEnabled > rollout table 1\`] = \`
[
  "u-1: true",
  "u-2: false",
  "u-3: true",
]
\`;
`,
    },
    {
      path: 'package-lock.json',
      diff: `
     "node_modules/vitest": {
-      "version": "5.0.4",
-      "resolved": "https://registry.npmjs.org/vitest/-/vitest-5.0.4.tgz",
+      "version": "5.1.0",
+      "resolved": "https://registry.npmjs.org/vitest/-/vitest-5.1.0.tgz",
       "dev": true,
`,
    },
    {
      path: 'tsconfig.json',
      diff: `
 {
   "compilerOptions": {
     "target": "ES2023",
-    "strict": false,
+    "strict": true,
     "module": "ESNext"
   }
 }
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Stable hash bucket per flag and user',
        labels: ['AC1'],
        keywords: ['stable hash'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: '0% enables nobody, 100% enables everybody',
        labels: ['AC2'],
        keywords: ['rollout of 100%', 'every user'],
        accept: ['contradicts'],
      },
      {
        id: 'AC3',
        requirement: 'Definitions cached for at most 60 seconds',
        labels: ['AC3'],
        keywords: ['60 seconds'],
        accept: ['covered'],
      },
      {
        id: 'AC4',
        requirement: 'Audit log entry for every rollout change',
        labels: ['AC4'],
        keywords: ['audit log'],
        accept: ['missing'],
      },
    ],
    mustScenarios: [
      {
        id: 'hundred-percent',
        risk: 'At 100% rollout users in bucket 100 stay disabled (buckets are 1–100 and the check is bucket < percent), so about 1% of users never get the flag',
        keywords: [['100%', '100 %', '100 percent', 'bucket 100', 'every user', 'all users']],
      },
      {
        id: 'zero-percent',
        risk: 'At 0% rollout no user gets the flag',
        keywords: [['0%', '0 %', 'zero', '0 percent']],
      },
      {
        id: 'stable',
        risk: 'The same user evaluated repeatedly (and on different servers) gets the same answer; raising the percentage only adds users',
        keywords: [['same user', 'stable', 'consistent', 'determinis', 'sticky', 'repeated']],
      },
      {
        id: 'cache-ttl',
        risk: 'After a rollout change, servers pick it up within 60 seconds and not before the cached entry expires',
        keywords: [['cache', 'ttl', '60 s', '60-second', '60 second', 'one minute', 'within a minute']],
      },
      {
        id: 'audit',
        risk: 'Changing a rollout percentage writes an audit entry with old value, new value and actor',
        keywords: [['audit']],
      },
      {
        id: 'invalid-percent',
        risk: 'Rollout values -1, 101 and 12.5 are rejected with RangeError',
        keywords: [['101', '-1', 'negative', 'invalid', 'rangeerror', 'non-integer', '12.5']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'User segments, country targeting and A/B metrics are in neither the issue nor the code',
        patterns: ['user segment', 'country target', 'a/b metric', 'conversion rate'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['flags', 'typescript', 'noise', 'boundary', 'contradicts', 'missing'],
    notes:
      'AC2 is contradicted at the upper bound (buckets 1–100 with bucket < percent leaves bucket 100 out at 100%) and AC4 (audit log) is absent. Tests, snapshot, lockfile and tsconfig are noise.',
  },
};
