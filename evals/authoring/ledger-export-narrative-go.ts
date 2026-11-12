import type { AuthoredCase } from './build';

/**
 * Narrative PRD (no list, no criteria heading): acceptanceCriteria is empty as PRD-07 would leave
 * it, and the three requirements are prose with one inline label each.
 */
export const ledgerExportNarrativeGo: AuthoredCase = {
  id: 'ledger-export-narrative-go',
  pr: {
    number: 2006,
    title: 'Ledger CSV export for finance',
    author: 'priya',
    headRef: 'feat/ledger-export',
    body: `
Closes #1906

Adds GET /finance/accounts/{id}/ledger.csv. Entries are read with keyset pagination and written
to the response as they arrive, so memory stays flat for large accounts.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#1906',
      url: 'https://github.com/acme/shop/issues/1906',
      title: 'Finance needs a ledger export',
      acceptanceCriteria: [],
      body: `
Finance downloads every merchant account's ledger at month end and imports it into the accounting
tool, which is strict about number formats. Every amount has to be written with exactly two decimals,
and debits carry a leading minus sign, so a debit of five cents reads -0.05 (AC1).

The biggest merchants have several hundred thousand entries. Loading them all at once has taken the
reporting box down before, so the export reads and writes 5,000 entries at a time and never holds a
whole account in memory (AC2).

Month-end close runs against a deadline. An export of 100,000 entries has to finish within 30 seconds
on production data (AC3), otherwise the team falls back to asking engineering for a database dump.
`,
    },
  ],
  files: [
    {
      path: 'internal/ledger/export.go',
      content: `
package ledger

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"time"
)

// ExportPageSize is how many entries are read and written per round trip.
const ExportPageSize = 5000

type Entry struct {
	ID          int64
	PostedAt    time.Time
	Description string
	// AmountMinor is always positive; Debit tells the direction.
	AmountMinor int64
	Debit       bool
}

// FormatAmount renders minor units with two decimals and a minus sign for debits.
func FormatAmount(minor int64, debit bool) string {
	sign := ""
	if debit {
		sign = "-"
	}
	return fmt.Sprintf("%s%d.%02d", sign, minor/100, minor%100)
}

type Exporter struct {
	repo Repository
}

func NewExporter(repo Repository) *Exporter { return &Exporter{repo: repo} }

// WriteCSV streams the account's ledger as CSV, one page of entries at a time.
func (e *Exporter) WriteCSV(ctx context.Context, w io.Writer, accountID string) error {
	cw := csv.NewWriter(w)
	if err := cw.Write([]string{"id", "posted_at", "description", "amount"}); err != nil {
		return err
	}
	var after int64
	for {
		page, err := e.repo.ListAfter(ctx, accountID, after, ExportPageSize)
		if err != nil {
			return err
		}
		for _, en := range page {
			row := []string{
				strconv.FormatInt(en.ID, 10),
				en.PostedAt.UTC().Format(time.RFC3339),
				en.Description,
				FormatAmount(en.AmountMinor, en.Debit),
			}
			if err := cw.Write(row); err != nil {
				return err
			}
		}
		cw.Flush()
		if err := cw.Error(); err != nil {
			return err
		}
		if len(page) < ExportPageSize {
			return nil
		}
		after = page[len(page)-1].ID
	}
}
`,
    },
    {
      path: 'internal/ledger/repo.go',
      diff: `
 package ledger

 import (
 	"context"
 	"database/sql"
 )

 type Repository interface {
 	Balance(ctx context.Context, accountID string) (int64, error)
+	ListAfter(ctx context.Context, accountID string, afterID int64, limit int) ([]Entry, error)
 }

 type sqlRepo struct{ db *sql.DB }

 func (r *sqlRepo) Balance(ctx context.Context, accountID string) (int64, error) {
 	var b int64
 	err := r.db.QueryRowContext(ctx, "SELECT balance_minor FROM accounts WHERE id = $1", accountID).Scan(&b)
 	return b, err
 }
+
+func (r *sqlRepo) ListAfter(ctx context.Context, accountID string, afterID int64, limit int) ([]Entry, error) {
+	rows, err := r.db.QueryContext(ctx,
+		"SELECT id, posted_at, description, amount_minor, debit FROM ledger_entries "+
+			"WHERE account_id = $1 AND id > $2 ORDER BY id LIMIT $3",
+		accountID, afterID, limit)
+	if err != nil {
+		return nil, err
+	}
+	defer rows.Close()
+	out := make([]Entry, 0, limit)
+	for rows.Next() {
+		var e Entry
+		if err := rows.Scan(&e.ID, &e.PostedAt, &e.Description, &e.AmountMinor, &e.Debit); err != nil {
+			return nil, err
+		}
+		out = append(out, e)
+	}
+	return out, rows.Err()
+}
`,
    },
    {
      path: 'internal/http/finance.go',
      diff: `
 package http

 import (
 	"net/http"
+
+	"github.com/acme/shop/internal/ledger"
 )

 type FinanceHandler struct {
-	Accounts AccountService
+	Accounts AccountService
+	Exporter *ledger.Exporter
 }

 func (h *FinanceHandler) Routes(mux *http.ServeMux) {
 	mux.HandleFunc("GET /finance/accounts/{id}/balance", h.balance)
+	mux.HandleFunc("GET /finance/accounts/{id}/ledger.csv", h.exportLedger)
 }
+
+func (h *FinanceHandler) exportLedger(w http.ResponseWriter, r *http.Request) {
+	id := r.PathValue("id")
+	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
+	w.Header().Set("Content-Disposition", "attachment; filename=ledger-"+id+".csv")
+	if err := h.Exporter.WriteCSV(r.Context(), w, id); err != nil {
+		// Headers are already sent; the truncated body is all the client can see.
+		return
+	}
+}
`,
    },
  ],
  expected: {
    expectedAlignment: 'partial',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Two decimals, leading minus sign for debits',
        labels: ['AC1'],
        keywords: ['two decimals', 'minus sign'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Read and write 5,000 entries at a time',
        labels: ['AC2'],
        keywords: ['5,000 entries'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: '100,000 entries exported within 30 seconds',
        labels: ['AC3'],
        keywords: ['30 seconds'],
        accept: ['unclear'],
      },
    ],
    mustScenarios: [
      {
        id: 'amount-format',
        risk: 'A five-cent debit is written as -0.05 and a 1,234.50 credit as 1234.50 (two decimals, sign only on debits)',
        keywords: [['-0.05', '0.05', 'two decimal', '2 decimal', 'minus', 'negative', 'sign']],
      },
      {
        id: 'page-boundary',
        risk: 'Accounts with exactly 5,000 and 5,001 entries: every entry is exported once, none duplicated or skipped across the page boundary',
        keywords: [['5,000', '5000', '5,001', '5001', 'page boundary', 'pagination', 'duplicate', 'skipped']],
      },
      {
        id: 'empty-account',
        risk: 'An account with no entries returns only the CSV header',
        keywords: [['empty', 'no entries', 'zero entries', 'header only', 'only the header']],
      },
      {
        id: 'mid-stream-error',
        risk: 'A database error after the first page leaves a truncated file with a 200 status, which finance could import as complete',
        keywords: [
          ['error', 'fail'],
          ['truncat', 'partial', 'incomplete', 'mid-stream', 'midway', 'half'],
        ],
      },
      {
        id: 'csv-escaping',
        risk: 'Descriptions containing commas, quotes or newlines are escaped so columns stay aligned',
        keywords: [['comma', 'quote', 'newline', 'escap']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Excel or PDF exports and date-range filters are in neither the issue nor the code',
        patterns: ['xlsx', 'pdf export', 'date range filter'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['finance', 'go', 'narrative-ac', 'unclear', 'performance'],
    notes:
      'Narrative PRD with no extractable criteria. AC3 is unclear by design: a 30-second target for 100,000 entries cannot be judged from code. AC1 and AC2 are implemented.',
  },
};
