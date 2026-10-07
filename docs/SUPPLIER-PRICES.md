# Supplier price synchronization

The supplier Excel endpoint is used only by a backend job. Configure these
environment variables in a private runtime environment file:

```dotenv
SUUSHA_PRICE_API_URL=https://suusha.com/Excel/api.php
SUUSHA_PRICE_API_KEY=
PRIVATE_DATA_DIR=/app/data
MATERIAL_LIBRARY_DIR=/app/data/material-library
SOURCE_SYNC_BACKUP_DIR=/app/data/source-price-backups
```

Never put the credential in a command argument, browser bundle, committed file,
image layer, public log or fixture. HTTP redirects are rejected so the credential
cannot be forwarded to another endpoint. Failures redact credential values.

The feed is an array of `sku`, `stock_qty`, and `unit_sales_price_02` rows. The
price column was matched against the website's exact variant Resale (`price2`)
values for every managed SKU before enabling this adapter. It contains **LKR**,
despite the source website offering a USD display. The adapter fetches the
website's current public currency script on every run and reproduces its
two-decimal USD display rounding. This USD value is the product's source price;
the retail-pricing extension applies the separate 1.1 and upward `.99` policy.

The private `store-map.json` retains the existing schema version 1 and
`site-resale-display` policy. Every entry must contain its exact case-sensitive
`sourceVariantSku`, managed `storeSku`, `storeUrlKey`, and `sourceId`. An API SKU
is never inferred from a prefix, category, color, size, or text similarity.

`MATERIAL_LIBRARY_DIR` defaults to `PRIVATE_DATA_DIR/material-library` (with
`SHUSHA_MATERIAL_LIBRARY_DIR` supported as an alias). `PRIVATE_DATA_DIR` defaults
to the ignored `data` directory in the app root. `SOURCE_SYNC_BACKUP_DIR` defaults
to `PRIVATE_DATA_DIR/source-price-backups`. Keep these in private runtime volumes.

```sh
node scripts/shusha-sync-prices.mjs --dry-run
node scripts/shusha-sync-prices.mjs --apply
```

Dry-run is the default. Each run caches the supplier response and source
currency script in the private backup volume with SHA-256 provenance, capture
timestamps, original LKR, USD divisor, a pre-write snapshot and journal. No API
URL containing a credential is persisted.

Schema or mapping conflicts stop the batch. Missing, ambiguous, invalid-price or
unavailable managed variants retain their existing store prices and produce a
`partial` result (exit 2); unrelated unusable rows produce aggregate diagnostics.
The job takes the shared publication and source-price advisory locks, in that
order, and updates only
`product.price` in a single transaction, verifies the write, then commits.
Supplier stock is availability evidence only: this job never writes inventory,
replenishes the store's order-request capacity, or reprices historical orders.

The scheduled production job remains 09:00 Asia/Shanghai. Run it only against the
active deployment's private database and volumes. Preview uses independent
volumes/database and does not run production schedules. Material capture,
gallery verification, READY review, and publication are separate operations.

If a final journal write fails after commit, the process reports
`applied-journal-failed`. Inspect the committed prices and prepared snapshot
before retrying; do not restore an old database dump over newer customer orders.
