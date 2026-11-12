import type { AuthoredCase } from './build';

export const reportTimezone: AuthoredCase = {
  id: 'report-timezone',
  pr: {
    number: 507,
    title: 'Daily sales report',
    author: 'hana',
    headRef: 'feat/daily-sales-report',
    body: `
Notion spec: https://www.notion.so/acme/Daily-sales-report-3f2a9c1b7d8e4f60a1b2c3d4e5f60718

Builds the per-store daily report that the dashboard and the morning e-mail use.
`,
  },
  prd: [
    {
      source: 'notion',
      id: '3f2a9c1b7d8e4f60a1b2c3d4e5f60718',
      url: 'https://www.notion.so/acme/Daily-sales-report-3f2a9c1b7d8e4f60a1b2c3d4e5f60718',
      title: 'Daily sales report',
      acceptanceCriteria: [
        "AC1: The report covers one calendar day in the store's own time zone (store.timezone), from 00:00 to 24:00 local time.",
        'AC2: Orders with status paid or refunded are included. Cancelled orders are not.',
        "AC3: The total is formatted with the store's locale (store.locale) and currency.",
      ],
      body: `
# Daily sales report

Store managers open the dashboard in the morning and want yesterday's numbers. We have
stores in Seoul, Berlin and Los Angeles.

## Acceptance Criteria
- AC1: The report covers one calendar day in the store's own time zone (store.timezone), from 00:00 to 24:00 local time.
- AC2: Orders with status paid or refunded are included. Cancelled orders are not.
- AC3: The total is formatted with the store's locale (store.locale) and currency.
`,
    },
  ],
  files: [
    {
      path: 'reports/daily_sales.py',
      content: `
from datetime import date, datetime, timedelta, timezone

from babel.numbers import format_currency

INCLUDED_STATUSES = ("paid", "refunded")


def day_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return start, start + timedelta(days=1)


def build_daily_report(store, day: date, orders_repo) -> dict:
    start, end = day_bounds(day)
    orders = orders_repo.find_between(store.id, start, end, statuses=INCLUDED_STATUSES)
    total = sum(order.amount for order in orders)
    return {
        "store_id": store.id,
        "day": day.isoformat(),
        "order_count": len(orders),
        "total": format_currency(total, store.currency, locale=store.locale),
    }
`,
    },
    {
      path: 'reports/__init__.py',
      diff: `
 from reports.inventory import build_inventory_report
+from reports.daily_sales import build_daily_report

-__all__ = ["build_inventory_report"]
+__all__ = ["build_inventory_report", "build_daily_report"]
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: "Day boundaries in the store's time zone",
        labels: ['AC1'],
        keywords: ['time zone', 'store.timezone'],
        accept: ['contradicts'],
      },
      {
        id: 'AC2',
        requirement: 'paid and refunded included, cancelled excluded',
        labels: ['AC2'],
        keywords: ['refunded', 'Cancelled'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: "Total formatted with the store's locale",
        labels: ['AC3'],
        keywords: ['locale'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'local-midnight',
        risk: 'An order placed shortly after local midnight in a non-UTC store (e.g. Seoul 00:30) must count for the local day, but UTC boundaries put it on the previous day',
        keywords: [
          ['time zone', 'timezone', 'utc', 'local'],
          ['midnight', '00:', '23:', 'boundar', 'previous day', 'next day', 'wrong day'],
        ],
      },
      { id: 'cancelled', risk: 'Cancelled orders are left out of count and total', keywords: [['cancel']] },
      {
        id: 'locale-format',
        risk: "The total uses the store's locale formatting (e.g. de_DE vs en_US separators)",
        keywords: [['locale', 'de_de', 'separator', 'format']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'E-mail delivery, CSV export and multi-currency conversion are not in this change',
        patterns: ['csv export', 'exchange rate', 'currency conversion'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['timezone', 'python', 'contradicts'],
    notes: 'AC1 is contradicted: day_bounds() uses UTC midnight and never reads store.timezone.',
  },
};
