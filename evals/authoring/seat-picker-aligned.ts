import type { AuthoredCase } from './build';

export const seatPickerAligned: AuthoredCase = {
  id: 'seat-picker-aligned',
  pr: {
    number: 2008,
    title: 'Seat picker for the booking page',
    author: 'hana',
    headRef: 'feat/seat-picker',
    body: `
Resolves #1908

New SeatPicker with a useSeatSelection hook. Sold and held seats come from the seat map API
as status values and are rendered disabled.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#1908',
      url: 'https://github.com/acme/shop/issues/1908',
      title: 'Let customers pick their seats',
      acceptanceCriteria: [
        'AC1: A customer can select at most 6 seats; trying to select a 7th seat shows "You can select up to 6 seats" and leaves the selection unchanged.',
        'AC2: Sold and held seats are shown as unavailable and cannot be selected.',
        'AC3: Changing the showtime clears the current selection.',
        'AC4: The Continue button is disabled while no seat is selected.',
      ],
      body: `
Today the booking page assigns seats automatically and customers complain they cannot sit together.

- [ ] AC1: A customer can select at most 6 seats; trying to select a 7th seat shows "You can select up to 6 seats" and leaves the selection unchanged.
- [ ] AC2: Sold and held seats are shown as unavailable and cannot be selected.
- [ ] AC3: Changing the showtime clears the current selection.
- [ ] AC4: The Continue button is disabled while no seat is selected.
`,
    },
  ],
  files: [
    {
      path: 'web/src/seats/useSeatSelection.ts',
      content: `
import { useEffect, useState } from 'react';

export const MAX_SEATS = 6;
export const TOO_MANY_SEATS = 'You can select up to 6 seats';

export function useSeatSelection(showtimeId: string) {
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A new showtime has a different seat map, so the old selection no longer applies.
  useEffect(() => {
    setSelected([]);
    setError(null);
  }, [showtimeId]);

  function toggle(seatId: string) {
    if (selected.includes(seatId)) {
      setSelected(selected.filter((id) => id !== seatId));
      setError(null);
      return;
    }
    if (selected.length >= MAX_SEATS) {
      setError(TOO_MANY_SEATS);
      return;
    }
    setSelected([...selected, seatId]);
    setError(null);
  }

  return { selected, error, toggle };
}
`,
    },
    {
      path: 'web/src/seats/SeatPicker.tsx',
      content: `
import { SeatMap, type Seat } from './SeatMap';
import { useSeatSelection } from './useSeatSelection';

interface Props {
  showtimeId: string;
  seats: Seat[];
  onContinue: (seatIds: string[]) => void;
}

export function SeatPicker({ showtimeId, seats, onContinue }: Props) {
  const { selected, error, toggle } = useSeatSelection(showtimeId);

  return (
    <section aria-label="Choose your seats">
      <SeatMap seats={seats} selected={selected} onToggle={toggle} />
      {error && (
        <p role="alert" className="seat-error">
          {error}
        </p>
      )}
      <button type="button" disabled={selected.length === 0} onClick={() => onContinue(selected)}>
        Continue ({selected.length})
      </button>
    </section>
  );
}
`,
    },
    {
      path: 'web/src/seats/SeatMap.tsx',
      diff: `
-export interface Seat {
-  id: string;
-  row: string;
-  number: number;
-}
+export type SeatStatus = 'available' | 'sold' | 'held';
+
+export interface Seat {
+  id: string;
+  row: string;
+  number: number;
+  status: SeatStatus;
+}

-export function SeatMap({ seats }: { seats: Seat[] }) {
+interface Props {
+  seats: Seat[];
+  selected: string[];
+  onToggle: (seatId: string) => void;
+}
+
+export function SeatMap({ seats, selected, onToggle }: Props) {
   return (
     <div className="seat-map">
-      {seats.map((seat) => (
-        <span key={seat.id} className="seat">
-          {seat.row}
-          {seat.number}
-        </span>
-      ))}
+      {seats.map((seat) => {
+        const unavailable = seat.status !== 'available';
+        return (
+          <button
+            key={seat.id}
+            type="button"
+            className={unavailable ? 'seat seat--unavailable' : 'seat'}
+            disabled={unavailable}
+            aria-pressed={selected.includes(seat.id)}
+            onClick={() => onToggle(seat.id)}
+          >
+            {seat.row}
+            {seat.number}
+          </button>
+        );
+      })}
     </div>
   );
 }
`,
    },
  ],
  expected: {
    expectedAlignment: 'aligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'At most 6 seats; the 7th shows a message and changes nothing',
        labels: ['AC1'],
        keywords: ['at most 6 seats', '7th seat'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Sold and held seats unavailable',
        labels: ['AC2'],
        keywords: ['sold and held'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: 'Showtime change clears the selection',
        labels: ['AC3'],
        keywords: ['changing the showtime'],
        accept: ['covered'],
      },
      {
        id: 'AC4',
        requirement: 'Continue disabled with no seat selected',
        labels: ['AC4'],
        keywords: ['continue button'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'seventh-seat',
        risk: 'With 6 seats selected, clicking a 7th shows "You can select up to 6 seats" and the selection stays at 6',
        keywords: [['7th', 'seventh', '7 seats', 'up to 6', 'more than 6', 'sixth']],
      },
      {
        id: 'deselect-then-add',
        risk: 'At 6 seats, deselecting one clears the message and allows choosing another seat',
        keywords: [['deselect', 'unselect', 'de-select', 'remove a seat', 'toggle off', 'click again']],
      },
      {
        id: 'unavailable',
        risk: 'Sold and held seats render disabled and clicking them does not add them',
        keywords: [['sold', 'held', 'unavailable']],
      },
      {
        id: 'showtime-reset',
        risk: 'Switching to another showtime empties the selection and the error message',
        keywords: [['showtime']],
      },
      {
        id: 'continue-disabled',
        risk: 'Continue is disabled with zero seats and enabled after selecting one',
        keywords: [['continue']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description:
          'Wheelchair seats, seat prices and seat holds by the customer are in neither the issue nor the code',
        patterns: ['wheelchair', 'seat price', 'vip seat'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['booking', 'tsx', 'react', 'aligned'],
    notes:
      'Fully implemented UI: 6-seat cap with message, disabled sold/held seats, reset on showtime change, disabled Continue.',
  },
};
