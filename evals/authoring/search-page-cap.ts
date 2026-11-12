import type { AuthoredCase } from './build';

export const searchPageCap: AuthoredCase = {
  id: 'search-page-cap',
  split: 'dev',
  pr: {
    number: 842,
    title: 'Cursor pagination for product search',
    author: 'wei',
    headRef: 'feat/search-cursor-pagination',
    body: `
Ticket: https://acme.atlassian.net/browse/SRCH-57

Replaces offset paging with a keyset cursor. One extra row is fetched to know whether
another page exists.
`,
  },
  prd: [
    {
      source: 'jira',
      id: 'SRCH-57',
      url: 'https://acme.atlassian.net/browse/SRCH-57',
      title: 'Stable pagination for product search',
      acceptanceCriteria: [
        'AC1: When the limit parameter is absent, a page has 20 results.',
        'AC2: The limit is capped at 100. A larger value is reduced to 100.',
        'AC3: Results are ordered by created_at descending, then id descending, so paging is stable.',
        'AC4: next_cursor is an empty string on the last page.',
      ],
      body: `
Offset paging skips or repeats products when the catalogue changes between requests.

## Acceptance Criteria
- AC1: When the limit parameter is absent, a page has 20 results.
- AC2: The limit is capped at 100. A larger value is reduced to 100.
- AC3: Results are ordered by created_at descending, then id descending, so paging is stable.
- AC4: next_cursor is an empty string on the last page.
`,
    },
  ],
  files: [
    {
      path: 'internal/search/handler.go',
      diff: `
 package search

 import (
     "encoding/json"
     "net/http"
     "strconv"
 )

+const (
+    defaultLimit = 20
+    maxLimit     = 500
+)
+
 type response struct {
-    Items []Product \`json:"items"\`
-    Page  int       \`json:"page"\`
+    Items      []Product \`json:"items"\`
+    NextCursor string    \`json:"next_cursor"\`
 }

 func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
     query := r.URL.Query().Get("q")
-    page, _ := strconv.Atoi(r.URL.Query().Get("page"))
-    items, err := h.store.SearchPage(r.Context(), query, page, 20)
+    limit := defaultLimit
+    if raw := r.URL.Query().Get("limit"); raw != "" {
+        parsed, err := strconv.Atoi(raw)
+        if err != nil || parsed < 1 {
+            http.Error(w, "limit must be a positive integer", http.StatusBadRequest)
+            return
+        }
+        limit = parsed
+        if limit > maxLimit {
+            limit = maxLimit
+        }
+    }
+
+    cursor, err := decodeCursor(r.URL.Query().Get("cursor"))
+    if err != nil {
+        http.Error(w, "invalid cursor", http.StatusBadRequest)
+        return
+    }
+
+    // Fetch one extra row to learn whether another page exists.
+    items, err := h.store.SearchAfter(r.Context(), query, cursor, limit+1)
     if err != nil {
         http.Error(w, "search failed", http.StatusInternalServerError)
         return
     }
-    json.NewEncoder(w).Encode(response{Items: items, Page: page})
+
+    next := ""
+    if len(items) > limit {
+        items = items[:limit]
+        last := items[len(items)-1]
+        next = encodeCursor(last.CreatedAt, last.ID)
+    }
+    json.NewEncoder(w).Encode(response{Items: items, NextCursor: next})
 }
`,
    },
    {
      path: 'internal/search/store.go',
      content: `
package search

import (
    "context"
    "time"
)

const searchAfterSQL = "SELECT id, name, created_at FROM products " +
    "WHERE name ILIKE '%' || $1 || '%' AND (created_at, id) < ($2, $3) " +
    "ORDER BY created_at DESC, id DESC LIMIT $4"

type Cursor struct {
    CreatedAt time.Time
    ID        string
}

func (s *Store) SearchAfter(ctx context.Context, query string, after Cursor, limit int) ([]Product, error) {
    rows, err := s.db.QueryContext(ctx, searchAfterSQL, query, after.CreatedAt, after.ID, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var items []Product
    for rows.Next() {
        var p Product
        if err := rows.Scan(&p.ID, &p.Name, &p.CreatedAt); err != nil {
            return nil, err
        }
        items = append(items, p)
    }
    return items, rows.Err()
}
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Default page size 20',
        labels: ['AC1'],
        keywords: ['20 results', 'limit parameter is absent'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Limit capped at 100',
        labels: ['AC2'],
        keywords: ['capped at 100', 'reduced to 100'],
        accept: ['contradicts'],
      },
      {
        id: 'AC3',
        requirement: 'Ordered by created_at desc, id desc',
        labels: ['AC3'],
        keywords: ['ordered by', 'paging is stable'],
        accept: ['covered'],
      },
      {
        id: 'AC4',
        requirement: 'next_cursor empty on the last page',
        labels: ['AC4'],
        keywords: ['next_cursor', 'last page'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'over-cap',
        risk: 'A limit above 100 (e.g. 150) must be reduced to 100; the code caps at 500 instead, so 150 rows come back',
        keywords: [
          [
            '101',
            '1000',
            '500',
            '200',
            '150',
            '250',
            '300',
            '10000',
            'above 100',
            'over 100',
            'greater than 100',
            'exceeds 100',
            'larger than 100',
            'more than 100',
          ],
        ],
      },
      {
        id: 'last-page',
        risk: 'The last page has an empty next_cursor',
        keywords: [['last page', 'final page', 'no more'], ['cursor']],
      },
      {
        id: 'tie-break',
        risk: 'Products with the same created_at are neither skipped nor repeated across pages',
        keywords: [
          [
            'same created_at',
            'identical created_at',
            'same timestamp',
            'identical timestamp',
            'tie',
            'equal created_at',
          ],
        ],
      },
      {
        id: 'default-limit',
        risk: 'Without a limit parameter a page has 20 results',
        keywords: [['20 results', '20 items', '20 products', 'default']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Fuzzy matching, facets and result caching are in neither the PRD nor the code',
        patterns: ['facet', 'fuzzy', 'cache hit'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['pagination', 'go', 'contradicts'],
    notes: 'AC2 is contradicted: the limit is capped at 500, not at 100.',
  },
};
