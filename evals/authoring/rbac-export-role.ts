import type { AuthoredCase } from './build';

export const rbacExportRole: AuthoredCase = {
  id: 'rbac-export-role',
  split: 'dev',
  pr: {
    number: 215,
    title: 'Restrict the user export endpoint',
    author: 'jun',
    headRef: 'fix/user-export-permissions',
    body: `
Closes #212

The export endpoint only checked that the caller was signed in. This adds a role check
and writes an audit entry for every export.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#212',
      url: 'https://github.com/acme/shop/issues/212',
      title: 'Lock down the user data export',
      acceptanceCriteria: [
        'AC1: Only users with the role admin can export user data. Every other role gets HTTP 403.',
        'AC2: Every export writes an audit log entry with the actor id and the number of exported rows.',
        'AC3: A user can run at most 5 exports per hour. Further requests get HTTP 429.',
      ],
      body: `
Support found that any signed-in back-office user can download the full customer list.

### Acceptance Criteria
- AC1: Only users with the role admin can export user data. Every other role gets HTTP 403.
- AC2: Every export writes an audit log entry with the actor id and the number of exported rows.
- AC3: A user can run at most 5 exports per hour. Further requests get HTTP 429.

Roles in the back office today: admin, manager, support, viewer.
`,
    },
  ],
  files: [
    {
      path: 'app/admin/export.py',
      diff: `
 from app.admin.csv import to_csv
-from app.errors import Unauthorized
+from app.errors import Forbidden, Unauthorized

 EXPORT_FIELDS = ("id", "email", "full_name", "created_at")
+EXPORT_ROLES = {"admin", "manager"}


-def export_users(request, db):
+def export_users(request, db, audit):
     actor = request.user
     if not actor.is_authenticated:
         raise Unauthorized()
+    if actor.role not in EXPORT_ROLES:
+        raise Forbidden("export requires an elevated role")

     rows = db.fetch_users(fields=EXPORT_FIELDS)
+    audit.record(action="user_export", actor_id=actor.id, row_count=len(rows))
     return to_csv(rows)
`,
    },
    {
      path: 'app/admin/routes.py',
      diff: `
 from app.admin.export import export_users
+from app.audit import audit_log
 from app.db import db


 def register(router):
-    router.get("/admin/users/export", lambda request: export_users(request, db))
+    router.get("/admin/users/export", lambda request: export_users(request, db, audit_log))
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Only admin may export',
        labels: ['AC1'],
        keywords: ['role admin', 'only users with'],
        accept: ['contradicts'],
      },
      {
        id: 'AC2',
        requirement: 'Audit log entry per export',
        labels: ['AC2'],
        keywords: ['audit log'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: 'At most 5 exports per hour',
        labels: ['AC3'],
        keywords: ['per hour', '429'],
        accept: ['missing'],
      },
    ],
    mustScenarios: [
      {
        id: 'manager-denied',
        risk: 'A manager (non-admin role) must be refused with 403, but the code lets managers export',
        keywords: [['manager']],
      },
      {
        id: 'other-roles-denied',
        risk: 'Support or viewer roles are refused with 403',
        keywords: [['support', 'viewer', 'non-admin']],
      },
      {
        id: 'audit',
        risk: 'A successful export writes an audit entry with actor id and row count',
        keywords: [['audit']],
      },
      {
        id: 'rate-limit',
        risk: 'The sixth export within an hour is rejected with 429',
        keywords: [['429', 'rate limit', 'rate-limit', 'sixth', '6th']],
      },
    ],
    forbidden: [
      {
        id: 'invented-auth',
        description: 'Two-factor authentication and IP allow-lists are in neither the issue nor the code',
        patterns: ['two-factor', '2fa', 'ip allow'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['auth', 'python', 'contradicts', 'missing'],
    notes: 'AC1 is contradicted (managers may export) and AC3 (rate limit) is missing.',
  },
};
