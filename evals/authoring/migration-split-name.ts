import type { AuthoredCase } from './build';

export const migrationSplitName: AuthoredCase = {
  id: 'migration-split-name',
  split: 'test',
  pr: {
    number: 611,
    title: 'Split users.full_name into first and last name',
    author: 'tomas',
    headRef: 'chore/split-user-name',
    body: `
Ticket: https://acme.atlassian.net/browse/CRM-310

Adds first_name / last_name and backfills them. The repository writes all three columns
so older readers of full_name keep working during the rollout.
`,
  },
  prd: [
    {
      source: 'jira',
      id: 'CRM-310',
      url: 'https://acme.atlassian.net/browse/CRM-310',
      title: 'Store first and last name separately',
      acceptanceCriteria: [
        'AC1: The users table gets first_name and last_name columns, and existing rows are backfilled from full_name.',
        'AC2: full_name stays in the table and keeps being written for one more release.',
        'AC3: The migration ships with a down script that restores the previous schema.',
      ],
      body: `
The CRM sync needs first and last name as separate fields.

## Acceptance Criteria
- AC1: The users table gets first_name and last_name columns, and existing rows are backfilled from full_name.
- AC2: full_name stays in the table and keeps being written for one more release.
- AC3: The migration ships with a down script that restores the previous schema.

## Notes
Backfill rule: everything before the first space is the first name, the rest is the last
name. A name without a space becomes the first name and the last name stays empty.
`,
    },
  ],
  files: [
    {
      path: 'db/migrations/0042_split_user_name.up.sql',
      content: `
ALTER TABLE users
    ADD COLUMN first_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN last_name  TEXT NOT NULL DEFAULT '';

UPDATE users
SET first_name = split_part(full_name, ' ', 1),
    last_name  = CASE
        WHEN position(' ' IN full_name) = 0 THEN ''
        ELSE substring(full_name FROM position(' ' IN full_name) + 1)
    END;
`,
    },
    {
      path: 'src/users/user-repository.ts',
      diff: `
 import type { Db } from '../db';

 export interface UserInput {
   email: string;
-  fullName: string;
+  firstName: string;
+  lastName: string;
 }

 export class UserRepository {
   constructor(private readonly db: Db) {}

   async create(input: UserInput): Promise<string> {
+    const fullName = [input.firstName, input.lastName].filter(Boolean).join(' ');
     const row = await this.db.one(
-      'INSERT INTO users (email, full_name) VALUES ($1, $2) RETURNING id',
-      [input.email, input.fullName],
+      'INSERT INTO users (email, first_name, last_name, full_name) VALUES ($1, $2, $3, $4) RETURNING id',
+      [input.email, input.firstName, input.lastName, fullName],
     );
     return row.id;
   }
 }
`,
    },
  ],
  expected: {
    expectedAlignment: 'partial',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'New columns with backfill',
        labels: ['AC1'],
        keywords: ['backfilled', 'first_name and last_name'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'full_name kept and still written',
        labels: ['AC2'],
        keywords: ['full_name stays', 'one more release'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: 'Down script exists',
        labels: ['AC3'],
        keywords: ['down script', 'restores the previous'],
        accept: ['missing'],
      },
    ],
    mustScenarios: [
      {
        id: 'single-word',
        risk: 'A full_name without a space becomes first_name with an empty last_name',
        keywords: [
          [
            'without a space',
            'no space',
            'single word',
            'single-word',
            'one word',
            'mononym',
            'single name',
            'only one',
          ],
        ],
      },
      {
        id: 'multi-word',
        risk: 'A name with several spaces keeps everything after the first space as the last name',
        keywords: [
          ['middle', 'multiple', 'several', 'three', 'more than one space', 'two spaces', 'compound'],
        ],
      },
      {
        id: 'rollback',
        risk: 'Rolling the migration back is not possible because there is no down script',
        keywords: [['rollback', 'roll back', 'rolled back', 'down script', 'down migration', 'revert']],
      },
      {
        id: 'old-reader',
        risk: 'Code that still reads full_name gets a correct value for users created after the change',
        keywords: [['full_name']],
      },
    ],
    secondOrder: [
      {
        id: 'null-full-name',
        risk: 'A row whose full_name is NULL.',
        why: 'zero-empty-same; spec only',
      },
      {
        id: 'leading-space',
        risk: 'A full_name that starts with a space.',
        why: 'exact-form; spec only',
      },
      {
        id: 'other-space-characters',
        risk: 'A full_name separated by a non-breaking or full-width space instead of a plain space.',
        why: 'exact-form; spec only',
      },
      {
        id: 'created-during-backfill',
        risk: 'A user is created while the backfill is running.',
        why: 'other-state; spec only',
      },
      {
        id: 'rename-after-migration',
        risk: 'A user changes their name after the migration has run.',
        why: 'and-then; spec only',
      },
      {
        id: 'name-longer-than-column',
        risk: 'A first or last name longer than the new column allows.',
        why: 'zero-empty-same; spec only',
      },
      {
        id: 'migration-run-twice',
        risk: 'The migration and its backfill are run a second time.',
        why: 'and-then; spec only',
      },
    ],
    forbidden: [
      {
        id: 'claims-column-dropped',
        description: 'The change does not drop full_name; saying it does is a misreading',
        patterns: [
          'drops full_name',
          'full_name is dropped',
          'full_name column is removed',
          'removes the full_name column',
        ],
        fields: ['summary', 'findings'],
      },
    ],
    tags: ['migration', 'sql', 'typescript', 'missing'],
    notes: 'AC3 is missing: only an .up.sql file is added, there is no down script.',
  },
};
