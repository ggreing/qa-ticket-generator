import type { AuthoredCase } from './build';

/**
 * Large multi-file PR (10 files) meant to run through map-reduce with a small token budget.
 * The supplier client has no retry at all; everything else in the issue is implemented.
 */
export const catalogSyncMapreduce: AuthoredCase = {
  id: 'catalog-sync-mapreduce',
  split: 'test',
  options: { tokenBudget: 9000 },
  pr: {
    number: 2010,
    title: 'Nightly supplier catalog sync',
    author: 'kwame',
    headRef: 'feat/catalog-sync',
    body: `
Closes #1910

Pulls the supplier catalog page by page, maps it onto our products and applies all changes in
one transaction at the end of the run. Big price moves go to the review queue instead.
Run with: python -m catalog.cli sync-catalog
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#1910',
      url: 'https://github.com/acme/shop/issues/1910',
      title: 'Sync the supplier catalog every night',
      acceptanceCriteria: [
        'AC1: The sync reads every page of the supplier catalog, following next_cursor until it is empty.',
        'AC2: When the supplier API answers with a 5xx status or times out, the request for that page is retried up to 5 times with exponential backoff starting at 1 second (1, 2, 4, 8 and 16 seconds).',
        'AC3: A price change of more than 30% (up or down) puts the product on the manual review list instead of updating its price.',
        'AC4: Products that no longer appear in the supplier catalog are marked inactive, never deleted.',
      ],
      body: `
The supplier publishes ~40k products. Ops currently uploads their CSV by hand twice a week.

### Acceptance Criteria
- AC1: The sync reads every page of the supplier catalog, following next_cursor until it is empty.
- AC2: When the supplier API answers with a 5xx status or times out, the request for that page is retried up to 5 times with exponential backoff starting at 1 second (1, 2, 4, 8 and 16 seconds).
- AC3: A price change of more than 30% (up or down) puts the product on the manual review list instead of updating its price.
- AC4: Products that no longer appear in the supplier catalog are marked inactive, never deleted.

The supplier API is flaky around 02:00 UTC when they run their own backups.
`,
    },
  ],
  files: [
    {
      path: 'catalog/sync/models.py',
      content: `
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class SupplierProduct:
    supplier_sku: str
    title: str
    price: str  # decimal string in EUR, e.g. "12.90"
    stock: int


@dataclass
class Product:
    sku: str
    title: str
    price_cents: int
    stock: int
    active: bool = True


@dataclass(frozen=True)
class Change:
    sku: str
    title: Optional[str] = None
    price_cents: Optional[int] = None
    stock: Optional[int] = None
`,
    },
    {
      path: 'catalog/sync/client.py',
      content: `
import requests

from catalog.sync.models import SupplierProduct


class SupplierClient:
    """Reads the supplier catalog API: GET /catalog?cursor=... returns items and next_cursor."""

    def __init__(self, base_url: str, token: str, page_size: int, timeout_seconds: float = 10.0):
        self._base_url = base_url.rstrip("/")
        self._page_size = page_size
        self._timeout = timeout_seconds
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {token}"

    def fetch_page(self, cursor: str | None) -> tuple[list[SupplierProduct], str | None]:
        params = {"limit": self._page_size}
        if cursor:
            params["cursor"] = cursor
        resp = self._session.get(f"{self._base_url}/catalog", params=params, timeout=self._timeout)
        resp.raise_for_status()
        body = resp.json()
        items = [
            SupplierProduct(
                supplier_sku=i["sku"], title=i["title"], price=i["price"], stock=int(i["stock"])
            )
            for i in body["items"]
        ]
        return items, body.get("next_cursor") or None
`,
    },
    {
      path: 'catalog/sync/mapper.py',
      content: `
from decimal import ROUND_HALF_UP, Decimal

from catalog.sync.models import SupplierProduct

SKU_PREFIX = "SUP-"


def to_sku(supplier_sku: str) -> str:
    return SKU_PREFIX + supplier_sku.strip().upper()


def to_cents(price: str) -> int:
    return int((Decimal(price) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def normalize_title(title: str) -> str:
    return " ".join(title.split())[:200]


def mapped_fields(item: SupplierProduct) -> dict:
    return {
        "sku": to_sku(item.supplier_sku),
        "title": normalize_title(item.title),
        "price_cents": to_cents(item.price),
        "stock": max(0, item.stock),
    }
`,
    },
    {
      path: 'catalog/sync/pricing.py',
      content: `
REVIEW_THRESHOLD = 0.30


def needs_review(old_cents: int, new_cents: int) -> bool:
    """True when the price moves by more than 30% in either direction."""
    if old_cents <= 0:
        return False
    return abs(new_cents - old_cents) / old_cents > REVIEW_THRESHOLD
`,
    },
    {
      path: 'catalog/sync/review.py',
      content: `
from dataclasses import dataclass


@dataclass(frozen=True)
class PriceReview:
    sku: str
    old_cents: int
    new_cents: int


class ReviewQueue:
    """Price changes waiting for a category manager; stored in the price_reviews table."""

    def __init__(self, db):
        self._db = db

    def add_all(self, reviews: list[PriceReview]) -> None:
        self._db.executemany(
            "INSERT INTO price_reviews (sku, old_cents, new_cents) VALUES (%s, %s, %s)",
            [(r.sku, r.old_cents, r.new_cents) for r in reviews],
        )
`,
    },
    {
      path: 'catalog/sync/repository.py',
      content: `
from catalog.sync.models import Change, Product


class ProductRepository:
    def __init__(self, db):
        self._db = db

    def load_supplier_products(self) -> dict[str, Product]:
        rows = self._db.query(
            "SELECT sku, title, price_cents, stock, active FROM products WHERE sku LIKE 'SUP-%%'"
        )
        return {r["sku"]: Product(**r) for r in rows}

    def apply(self, changes: list[Change], new_products: list[Product], deactivate: list[str]) -> None:
        for c in changes:
            fields = {k: v for k, v in c.__dict__.items() if k != "sku" and v is not None}
            if fields:
                assignments = ", ".join(f"{k} = %s" for k in fields)
                self._db.execute(
                    f"UPDATE products SET {assignments} WHERE sku = %s", [*fields.values(), c.sku]
                )
        for p in new_products:
            self._db.execute(
                "INSERT INTO products (sku, title, price_cents, stock, active) VALUES (%s, %s, %s, %s, true)",
                [p.sku, p.title, p.price_cents, p.stock],
            )
        if deactivate:
            self._db.execute("UPDATE products SET active = false WHERE sku = ANY(%s)", [deactivate])
`,
    },
    {
      path: 'catalog/sync/runner.py',
      content: `
import logging

from catalog.sync.mapper import mapped_fields
from catalog.sync.models import Change, Product
from catalog.sync.pricing import needs_review
from catalog.sync.review import PriceReview

log = logging.getLogger(__name__)


class CatalogSync:
    """Reads the whole supplier catalog first, then writes every change in one transaction."""

    def __init__(self, client, products, reviews, db):
        self._client = client
        self._products = products
        self._reviews = reviews
        self._db = db

    def run(self) -> dict:
        existing = self._products.load_supplier_products()
        seen: set[str] = set()
        changes: list[Change] = []
        new_products: list[Product] = []
        reviews: list[PriceReview] = []

        cursor = None
        pages = 0
        while True:
            items, cursor = self._client.fetch_page(cursor)
            pages += 1
            for item in items:
                fields = mapped_fields(item)
                sku = fields["sku"]
                seen.add(sku)
                current = existing.get(sku)
                if current is None:
                    new_products.append(Product(**fields))
                    continue
                price = fields["price_cents"]
                if price != current.price_cents and needs_review(current.price_cents, price):
                    reviews.append(PriceReview(sku, current.price_cents, price))
                    price = None
                elif price == current.price_cents:
                    price = None
                changes.append(Change(sku=sku, title=fields["title"], price_cents=price, stock=fields["stock"]))
            if not cursor:
                break

        deactivate = [sku for sku, p in existing.items() if p.active and sku not in seen]
        with self._db.transaction():
            self._products.apply(changes, new_products, deactivate)
            self._reviews.add_all(reviews)
        log.info("catalog sync: %d pages, %d changed, %d new, %d inactive, %d for review",
                 pages, len(changes), len(new_products), len(deactivate), len(reviews))
        return {"pages": pages, "new": len(new_products), "inactive": len(deactivate), "review": len(reviews)}
`,
    },
    {
      path: 'catalog/cli.py',
      diff: `
 import argparse
+import tomllib

 from catalog.db import connect
+from catalog.sync.client import SupplierClient
+from catalog.sync.repository import ProductRepository
+from catalog.sync.review import ReviewQueue
+from catalog.sync.runner import CatalogSync


 def main(argv=None):
     parser = argparse.ArgumentParser(prog="catalog")
     sub = parser.add_subparsers(dest="command", required=True)
     sub.add_parser("reindex")
+    sub.add_parser("sync-catalog")
     args = parser.parse_args(argv)

     db = connect()
     if args.command == "reindex":
         db.execute("REINDEX TABLE products")
+    elif args.command == "sync-catalog":
+        with open("config/catalog.toml", "rb") as f:
+            cfg = tomllib.load(f)["supplier"]
+        client = SupplierClient(cfg["base_url"], cfg["token"], cfg["page_size"], cfg["timeout_seconds"])
+        result = CatalogSync(client, ProductRepository(db), ReviewQueue(db), db).run()
+        print(result)
`,
    },
    {
      path: 'config/catalog.toml',
      content: `
[supplier]
base_url = "https://api.supplier.example/v2"
token = "\${SUPPLIER_TOKEN}"
page_size = 500
timeout_seconds = 10
`,
    },
    {
      path: 'tests/catalog/test_pricing.py',
      content: `
from catalog.sync.pricing import needs_review


def test_small_change_is_applied():
    assert not needs_review(1000, 1200)


def test_large_increase_goes_to_review():
    assert needs_review(1000, 1400)
`,
    },
  ],
  expected: {
    expectedAlignment: 'partial',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Every catalog page read via next_cursor',
        labels: ['AC1'],
        keywords: ['next_cursor'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Retry 5xx and timeouts up to 5 times with exponential backoff',
        labels: ['AC2'],
        keywords: ['exponential backoff', '5xx'],
        accept: ['missing'],
      },
      {
        id: 'AC3',
        requirement: 'Price changes over 30% go to manual review',
        labels: ['AC3'],
        keywords: ['more than 30%', 'manual review'],
        accept: ['covered'],
      },
      {
        id: 'AC4',
        requirement: 'Vanished products marked inactive, not deleted',
        labels: ['AC4'],
        keywords: ['marked inactive'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'retry-5xx',
        risk: 'The supplier answers 503 on page 7: the page must be retried with 1, 2, 4, 8 and 16 second backoff; today the first error ends the run',
        keywords: [
          ['5xx', '500', '502', '503', '504', 'timeout', 'time out', 'timed out'],
          ['retr', 'backoff', 'back-off', 'attempt'],
        ],
      },
      {
        id: 'failure-no-partial',
        risk: 'A failure on a later page leaves the catalog untouched: no change from the earlier pages is written',
        keywords: [
          [
            'partial',
            'rollback',
            'roll back',
            'untouched',
            'unchanged',
            'nothing is written',
            'no change',
            'transaction',
            'atomic',
          ],
        ],
      },
      {
        id: 'threshold-boundary',
        risk: 'A price change of exactly 30% is applied directly; 30.01% (or a 31% drop) goes to the review list',
        keywords: [['30%', '30 %', '31%', 'threshold', 'exactly 30']],
      },
      {
        id: 'price-drop-review',
        risk: 'A large price drop (more than 30% down) also goes to review, not only increases',
        keywords: [['drop', 'decrease', 'down', 'lower', 'reduction']],
      },
      {
        id: 'inactive',
        risk: 'A product missing from the supplier feed is marked inactive and keeps its row; a returning product is not reactivated automatically',
        keywords: [['inactive', 'deactivat', 'disappear', 'no longer', 'removed from']],
      },
      {
        id: 'cursor-end',
        risk: 'Pagination stops when next_cursor is empty or null; a last page with zero items does not loop',
        keywords: [['cursor', 'last page', 'pagination', 'next page']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Image sync and currency conversion are in neither the issue nor the code',
        patterns: ['image sync', 'product image', 'currency conversion', 'exchange rate'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['catalog', 'python', 'multi-file', 'map-reduce', 'external-failure', 'missing'],
    notes:
      'Map-reduce case (10 files). AC2 is absent: SupplierClient.fetch_page has a timeout but no retry or backoff. Changes are written in one transaction at the end, so a failure leaves nothing half-applied.',
  },
};
