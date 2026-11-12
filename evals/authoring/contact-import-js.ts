import type { AuthoredCase } from './build';

export const contactImportJs: AuthoredCase = {
  id: 'contact-import-js',
  split: 'dev',
  pr: {
    number: 2014,
    title: 'CSV contact import for the CRM',
    author: 'ravi',
    headRef: 'feat/contact-import',
    body: `
Closes #1914

POST /contacts/import takes a CSV upload (name,email,phone). The file is validated before
anything is written, then inserted in batches of 500.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#1914',
      url: 'https://github.com/acme/shop/issues/1914',
      title: 'Import contacts from CSV',
      acceptanceCriteria: [
        'AC1: An import file may contain at most 10,000 data rows (the header row not counted); a larger file is rejected before any row is imported.',
        'AC2: Rows with an invalid e-mail address are skipped and listed in the result with their line number; the valid rows are still imported.',
        'AC3: A contact whose e-mail address already exists is updated instead of created again; e-mail addresses are compared case-insensitively.',
      ],
      body: `
Sales teams paste contacts from trade fairs into spreadsheets and want to upload them in one go.

### Acceptance Criteria
- AC1: An import file may contain at most 10,000 data rows (the header row not counted); a larger file is rejected before any row is imported.
- AC2: Rows with an invalid e-mail address are skipped and listed in the result with their line number; the valid rows are still imported.
- AC3: A contact whose e-mail address already exists is updated instead of created again; e-mail addresses are compared case-insensitively.
`,
    },
  ],
  files: [
    {
      path: 'server/contacts/csv.js',
      content: `
'use strict';

/** Minimal CSV parser for name,email,phone files: quoted fields, "" escapes, CRLF or LF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\\n' || ch === '\\r') {
      if (ch === '\\r' && text[i + 1] === '\\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

module.exports = { parseCsv };
`,
    },
    {
      path: 'server/contacts/import.js',
      content: `
'use strict';

const { parseCsv } = require('./csv');

const MAX_ROWS = 10000;
const BATCH_SIZE = 500;
const EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

class ImportError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

async function importContacts(text, contacts) {
  const [header, ...rows] = parseCsv(text);
  if (!header || header.join(',').toLowerCase() !== 'name,email,phone') {
    throw new ImportError('BAD_HEADER');
  }
  if (rows.length > MAX_ROWS) {
    throw new ImportError('TOO_MANY_ROWS', { rows: rows.length, max: MAX_ROWS });
  }

  const records = rows.map(([name, email, phone], i) => {
    const line = i + 2; // line 1 is the header
    if (!EMAIL.test((email || '').trim())) {
      throw new ImportError('INVALID_EMAIL', { line });
    }
    return { name: (name || '').trim(), email: email.trim(), phone: (phone || '').trim() };
  });

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    await contacts.insertMany(records.slice(i, i + BATCH_SIZE));
  }
  return { imported: records.length, skipped: [] };
}

module.exports = { importContacts, ImportError, MAX_ROWS };
`,
    },
    {
      path: 'server/routes/contacts.js',
      diff: `
 'use strict';

 const express = require('express');
+const multer = require('multer');
+const { importContacts, ImportError } = require('../contacts/import');

 const router = express.Router();
+const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

 router.get('/contacts', async (req, res) => {
   res.json(await req.app.locals.contacts.list({ ownerId: req.user.id }));
 });
+
+router.post('/contacts/import', upload.single('file'), async (req, res) => {
+  try {
+    const result = await importContacts(req.file.buffer.toString('utf8'), req.app.locals.contacts);
+    res.json(result);
+  } catch (err) {
+    if (err instanceof ImportError) {
+      res.status(422).json({ error: err.code, details: err.details });
+      return;
+    }
+    throw err;
+  }
+});

 module.exports = router;
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'At most 10,000 data rows, rejected before importing',
        labels: ['AC1'],
        keywords: ['10,000 data rows'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Invalid e-mail rows skipped and reported; valid rows still imported',
        labels: ['AC2'],
        keywords: ['invalid e-mail', 'line number'],
        accept: ['contradicts'],
      },
      {
        id: 'AC3',
        requirement: 'Existing e-mail updates the contact, case-insensitive',
        labels: ['AC3'],
        keywords: ['case-insensitively', 'already exists'],
        accept: ['missing'],
      },
    ],
    mustScenarios: [
      {
        id: 'one-bad-row',
        risk: 'A file with 99 valid rows and one invalid e-mail must import the 99 and report the bad line; today the whole import is refused with INVALID_EMAIL',
        keywords: [
          ['invalid'],
          ['skip', 'line', 'whole', 'entire', 'all rows', 'valid rows', 'abort', 'reject'],
        ],
      },
      {
        id: 'row-limit',
        risk: 'Exactly 10,000 data rows are accepted (header not counted); 10,001 are rejected with TOO_MANY_ROWS before anything is written',
        keywords: [['10,000', '10000', '10,001', '10001', 'too_many_rows', 'row limit']],
      },
      {
        id: 'duplicate-email',
        risk: 'Importing a contact whose e-mail exists as Alice@Example.com (different case) updates it instead of creating a second contact',
        keywords: [
          [
            'duplicate',
            'already exist',
            'existing',
            'case-insensitive',
            'case insensitive',
            'upper',
            'lowercase',
          ],
        ],
      },
      {
        id: 'batch-failure',
        risk: 'A database error in the third batch of 500 leaves the first 1,000 contacts inserted with a 500 error response',
        keywords: [
          ['batch', '500'],
          ['fail', 'error', 'partial'],
        ],
      },
      {
        id: 'csv-quoting',
        risk: 'Quoted fields with commas, escaped quotes and CRLF line endings are parsed into the right columns',
        keywords: [['quote', 'comma', 'crlf', '\\r\\n', 'escap']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Excel uploads and column mapping are in neither the issue nor the code',
        patterns: ['xlsx', 'column mapping', 'excel upload'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['crm', 'javascript', 'boundary', 'contradicts', 'missing'],
    notes:
      'AC2 is contradicted: the first invalid e-mail throws INVALID_EMAIL and nothing is imported. AC3 (update existing e-mail, case-insensitive) is absent: rows are always inserted.',
  },
};
