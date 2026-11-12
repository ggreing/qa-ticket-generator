import type { AuthoredCase } from './build';

export const stockReserveGo: AuthoredCase = {
  id: 'stock-reserve-go',
  split: 'dev',
  pr: {
    number: 2002,
    title: 'Reserve stock when checkout starts',
    author: 'ayaan',
    headRef: 'feat/stock-reservations',
    body: `
Closes #1902

Checkout now reserves the units before payment. The decrement is a single conditional
UPDATE, so two shoppers racing for the last unit cannot both win.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#1902',
      url: 'https://github.com/acme/shop/issues/1902',
      title: 'Reserve stock at checkout',
      acceptanceCriteria: [
        'AC1: Concurrent reservations never take stock below zero; when there is not enough stock the request fails with ErrOutOfStock.',
        'AC2: A reservation that is not confirmed is released after 15 minutes and its quantity goes back to stock.',
        'AC3: One reservation request may ask for 1 to 10 units; 0, negative quantities and more than 10 units are rejected with ErrInvalidQuantity.',
      ],
      body: `
During the last sale we oversold the limited sneakers: two checkouts both saw one unit left.

### Acceptance Criteria
- AC1: Concurrent reservations never take stock below zero; when there is not enough stock the request fails with ErrOutOfStock.
- AC2: A reservation that is not confirmed is released after 15 minutes and its quantity goes back to stock.
- AC3: One reservation request may ask for 1 to 10 units; 0, negative quantities and more than 10 units are rejected with ErrInvalidQuantity.
`,
    },
  ],
  files: [
    {
      path: 'internal/inventory/reserve.go',
      content: `
package inventory

import (
	"context"
	"errors"
	"time"
)

var (
	ErrOutOfStock      = errors.New("inventory: not enough stock")
	ErrInvalidQuantity = errors.New("inventory: invalid quantity")
)

// MaxUnitsPerReservation is the largest quantity one request may reserve.
const MaxUnitsPerReservation = 10

// ReservationTTL is how long an unconfirmed reservation is kept.
const ReservationTTL = 15 * time.Minute

type Reservation struct {
	ID        string
	SKU       string
	Quantity  int
	ExpiresAt time.Time
	Confirmed bool
}

type Reserver struct {
	store Store
	now   func() time.Time
	newID func() string
}

func NewReserver(store Store, now func() time.Time, newID func() string) *Reserver {
	return &Reserver{store: store, now: now, newID: newID}
}

// Reserve takes qty units of sku out of stock and records an expiring reservation.
func (r *Reserver) Reserve(ctx context.Context, sku string, qty int) (Reservation, error) {
	if qty < 1 || qty >= MaxUnitsPerReservation {
		return Reservation{}, ErrInvalidQuantity
	}
	res := Reservation{
		ID:        r.newID(),
		SKU:       sku,
		Quantity:  qty,
		ExpiresAt: r.now().Add(ReservationTTL),
	}
	err := r.store.WithTx(ctx, func(tx Tx) error {
		ok, err := tx.DecrementStock(ctx, sku, qty)
		if err != nil {
			return err
		}
		if !ok {
			return ErrOutOfStock
		}
		return tx.InsertReservation(ctx, res)
	})
	if err != nil {
		return Reservation{}, err
	}
	return res, nil
}

// Confirm marks a reservation as paid so it is kept.
func (r *Reserver) Confirm(ctx context.Context, id string) error {
	return r.store.WithTx(ctx, func(tx Tx) error {
		return tx.ConfirmReservation(ctx, id)
	})
}
`,
    },
    {
      path: 'internal/inventory/store.go',
      diff: `
 package inventory

 import (
 	"context"
 	"database/sql"
 )

+type Tx interface {
+	DecrementStock(ctx context.Context, sku string, qty int) (bool, error)
+	InsertReservation(ctx context.Context, r Reservation) error
+	ConfirmReservation(ctx context.Context, id string) error
+}
+
 type Store interface {
 	StockOf(ctx context.Context, sku string) (int, error)
+	WithTx(ctx context.Context, fn func(Tx) error) error
 }

 type sqlStore struct{ db *sql.DB }

 func (s *sqlStore) StockOf(ctx context.Context, sku string) (int, error) {
 	var n int
 	err := s.db.QueryRowContext(ctx, "SELECT stock FROM products WHERE sku = $1", sku).Scan(&n)
 	return n, err
 }
+
+type sqlTx struct{ tx *sql.Tx }
+
+// DecrementStock subtracts qty only if enough stock is left; the check and the update are one statement.
+func (t *sqlTx) DecrementStock(ctx context.Context, sku string, qty int) (bool, error) {
+	res, err := t.tx.ExecContext(ctx,
+		"UPDATE products SET stock = stock - $1 WHERE sku = $2 AND stock >= $1", qty, sku)
+	if err != nil {
+		return false, err
+	}
+	n, err := res.RowsAffected()
+	return n == 1, err
+}
+
+func (t *sqlTx) InsertReservation(ctx context.Context, r Reservation) error {
+	_, err := t.tx.ExecContext(ctx,
+		"INSERT INTO reservations (id, sku, quantity, expires_at, confirmed) VALUES ($1, $2, $3, $4, false)",
+		r.ID, r.SKU, r.Quantity, r.ExpiresAt)
+	return err
+}
+
+func (t *sqlTx) ConfirmReservation(ctx context.Context, id string) error {
+	_, err := t.tx.ExecContext(ctx, "UPDATE reservations SET confirmed = true WHERE id = $1", id)
+	return err
+}
+
+func (s *sqlStore) WithTx(ctx context.Context, fn func(Tx) error) error {
+	tx, err := s.db.BeginTx(ctx, nil)
+	if err != nil {
+		return err
+	}
+	if err := fn(&sqlTx{tx: tx}); err != nil {
+		_ = tx.Rollback()
+		return err
+	}
+	return tx.Commit()
+}
`,
    },
    {
      path: 'internal/http/checkout.go',
      diff: `
 package http

 import (
+	"errors"
 	"net/http"

 	"github.com/acme/shop/internal/inventory"
 )

 type CheckoutHandler struct {
-	Stock inventory.Store
+	Stock    inventory.Store
+	Reserver *inventory.Reserver
 }

 func (h *CheckoutHandler) Start(w http.ResponseWriter, r *http.Request) {
 	req, err := decodeStart(r)
 	if err != nil {
 		writeError(w, http.StatusBadRequest, "invalid body")
 		return
 	}
-	writeJSON(w, http.StatusOK, map[string]string{"status": "started", "sku": req.SKU})
+	res, err := h.Reserver.Reserve(r.Context(), req.SKU, req.Quantity)
+	switch {
+	case errors.Is(err, inventory.ErrInvalidQuantity):
+		writeError(w, http.StatusBadRequest, "quantity must be between 1 and 10")
+		return
+	case errors.Is(err, inventory.ErrOutOfStock):
+		writeError(w, http.StatusConflict, "out of stock")
+		return
+	case err != nil:
+		writeError(w, http.StatusInternalServerError, "reservation failed")
+		return
+	}
+	writeJSON(w, http.StatusOK, map[string]any{"status": "started", "reservation": res.ID, "expiresAt": res.ExpiresAt})
 }
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'No overselling under concurrency; ErrOutOfStock when short',
        labels: ['AC1'],
        keywords: ['below zero', 'ErrOutOfStock'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Unconfirmed reservations released after 15 minutes',
        labels: ['AC2'],
        keywords: ['15 minutes', 'released'],
        accept: ['missing'],
      },
      {
        id: 'AC3',
        requirement: '1 to 10 units per request',
        labels: ['AC3'],
        keywords: ['1 to 10 units', 'ErrInvalidQuantity'],
        accept: ['contradicts'],
      },
    ],
    mustScenarios: [
      {
        id: 'ten-units',
        risk: 'Reserving exactly 10 units must succeed, but qty >= 10 rejects it (off-by-one at the upper bound)',
        keywords: [
          [
            '10 units',
            'ten units',
            'qty 10',
            'quantity 10',
            'quantity of 10',
            'exactly 10',
            '= 10',
            '>= 10',
            'boundary',
          ],
        ],
      },
      {
        id: 'bounds',
        risk: 'Quantities 0, -1 and 11 are rejected with ErrInvalidQuantity; 1 is accepted',
        keywords: [['errinvalidquantity', '400', '11', 'zero', 'negative']],
      },
      {
        id: 'last-unit-race',
        risk: 'Two concurrent reservations for the last unit: exactly one succeeds, the other gets ErrOutOfStock and stock stays at 0',
        keywords: [
          ['concurren', 'parallel', 'simultaneous', 'race', 'at the same time'],
          ['stock', 'last unit', 'erroutofstock', '409'],
        ],
      },
      {
        id: 'expiry-release',
        risk: 'An unconfirmed reservation older than 15 minutes is released and its units return to stock',
        keywords: [['15 min', 'fifteen', 'expir', 'release']],
      },
      {
        id: 'confirm-keeps',
        risk: 'A confirmed reservation is never released, even after 15 minutes',
        keywords: [['confirm']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Waitlists and back-order notifications exist in neither the issue nor the code',
        patterns: ['waitlist', 'back-order', 'backorder'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['inventory', 'go', 'concurrency', 'boundary', 'contradicts', 'missing'],
    notes:
      'AC3 is contradicted at the boundary (qty >= 10 rejects 10 units) and AC2 is absent: expires_at is stored but nothing releases expired reservations.',
  },
};
