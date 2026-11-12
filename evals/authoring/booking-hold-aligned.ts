import type { AuthoredCase } from './build';

export const bookingHoldAligned: AuthoredCase = {
  id: 'booking-hold-aligned',
  split: 'dev',
  pr: {
    number: 318,
    title: 'Seat holds for the booking flow',
    author: 'dario',
    headRef: 'feat/seat-holds',
    body: `
Ticket: https://acme.atlassian.net/browse/BOOK-88

Adds HoldSeats. A hold is one row per seat; the unique index on live holds is what
prevents double booking, so no application-level lock is needed.
`,
  },
  prd: [
    {
      source: 'jira',
      id: 'BOOK-88',
      url: 'https://acme.atlassian.net/browse/BOOK-88',
      title: 'Hold seats while the customer pays',
      acceptanceCriteria: [
        'AC1: Two customers can never hold the same seat for the same show. The second request fails with ErrSeatTaken.',
        'AC2: A hold expires 10 minutes after it is created, and an expired hold no longer blocks the seat.',
        'AC3: A single hold request can contain at most 4 seats. A request for more is rejected.',
      ],
      body: `
When a customer picks seats we keep them aside until payment finishes.

## Acceptance Criteria
- AC1: Two customers can never hold the same seat for the same show. The second request fails with ErrSeatTaken.
- AC2: A hold expires 10 minutes after it is created, and an expired hold no longer blocks the seat.
- AC3: A single hold request can contain at most 4 seats. A request for more is rejected.

A limit on how many seats one customer may hold in total across requests is out of scope here.
`,
    },
  ],
  files: [
    {
      path: 'internal/booking/hold.go',
      content: `
package booking

import (
    "context"
    "database/sql"
    "errors"
    "time"
)

const (
    MaxSeatsPerBooking = 4
    HoldTTL            = 10 * time.Minute
)

var (
    ErrSeatTaken        = errors.New("seat is already held")
    ErrInvalidSeatCount = errors.New("a booking holds between 1 and 4 seats")
)

const deleteExpiredSQL = "DELETE FROM seat_holds WHERE show_id = $1 AND expires_at <= $2"

// seat_holds has a unique index on (show_id, seat_id), so the insert is the lock.
const insertHoldSQL = "INSERT INTO seat_holds (show_id, seat_id, customer_id, expires_at) VALUES ($1, $2, $3, $4)"

type Hold struct {
    ShowID     string
    SeatIDs    []string
    CustomerID string
    ExpiresAt  time.Time
}

func (s *Service) HoldSeats(ctx context.Context, showID string, seatIDs []string, customerID string) (*Hold, error) {
    if len(seatIDs) == 0 || len(seatIDs) > MaxSeatsPerBooking {
        return nil, ErrInvalidSeatCount
    }

    tx, err := s.db.BeginTx(ctx, &sql.TxOptions{})
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    now := s.clock.Now()
    if _, err := tx.ExecContext(ctx, deleteExpiredSQL, showID, now); err != nil {
        return nil, err
    }

    expiresAt := now.Add(HoldTTL)
    for _, seatID := range seatIDs {
        if _, err := tx.ExecContext(ctx, insertHoldSQL, showID, seatID, customerID, expiresAt); err != nil {
            if isUniqueViolation(err) {
                return nil, ErrSeatTaken
            }
            return nil, err
        }
    }
    if err := tx.Commit(); err != nil {
        return nil, err
    }
    return &Hold{ShowID: showID, SeatIDs: seatIDs, CustomerID: customerID, ExpiresAt: expiresAt}, nil
}
`,
    },
    {
      path: 'db/migrations/0019_seat_holds.sql',
      content: `
CREATE TABLE seat_holds (
    show_id     TEXT        NOT NULL,
    seat_id     TEXT        NOT NULL,
    customer_id TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX seat_holds_show_seat ON seat_holds (show_id, seat_id);
`,
    },
  ],
  expected: {
    expectedAlignment: 'aligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'No double hold of a seat',
        labels: ['AC1'],
        keywords: ['same seat', 'ErrSeatTaken'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Holds expire after 10 minutes',
        labels: ['AC2'],
        keywords: ['10 minutes', 'expires'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: 'At most 4 seats per hold request',
        labels: ['AC3'],
        keywords: ['at most 4', '4 seats'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'double-hold',
        risk: 'Two customers try to hold the same seat; exactly one succeeds and the other gets ErrSeatTaken',
        keywords: [['same seat', 'errseattaken', 'already held']],
      },
      {
        id: 'expiry',
        risk: 'A hold stops blocking the seat once 10 minutes have passed',
        keywords: [['expir'], ['10 min', 'ten min', '10-min', 'ttl', '11 min', 'after']],
      },
      {
        id: 'too-many-seats',
        risk: 'A request for 5 seats is rejected',
        keywords: [
          ['5 seats', 'five seats', 'more than 4', 'more than four', 'fifth seat', 'errinvalidseatcount'],
        ],
      },
      {
        id: 'partial-failure',
        risk: 'One of several requested seats is taken: no seat of that request stays held (transaction rolls back)',
        keywords: [['roll', 'none of', 'no seats', 'atomic', 'partial', 'all or nothing', 'all-or-nothing']],
      },
    ],
    forbidden: [
      {
        id: 'invented-payment',
        description: 'Payment capture and refunds are not part of this change',
        patterns: ['refund', 'payment is captured', 'charge the card'],
        fields: ['findings'],
      },
    ],
    tags: ['concurrency', 'go', 'aligned'],
    notes:
      'Everything is implemented. A report that marks a requirement missing or contradicted is wrong here.',
  },
};
