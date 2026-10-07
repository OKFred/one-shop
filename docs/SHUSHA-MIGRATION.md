# SHUSHA v2 migration and recovery

The public repository is a native GPLv3 fork. `dev` follows upstream;
`shusha` starts at `v2.2.1`. Merchant behavior lives in four extensions,
with source files compiled to `dist`. Changes are reviewed through separate
foundation, catalog, payment and operations pull requests. Private merchant
data, images, environment files and receiving instructions are mounted at runtime.

## Candidate rehearsal

1. Save the old image ID, container configuration and a consistent PostgreSQL
   custom-format dump in a private recovery directory. Do not print container
   environment variables or bank configuration.
2. Restore into a newly named candidate database. Copy media, material-library,
   slot journals and private configuration into isolated candidate directories.
   Candidate `system.jobs` must remain empty. Do not point v1 at a v2 database.
3. Run `node deployment/capture-baseline.mjs --output /private/before.private.json`
   against the restored v1 copy before any migrations.
4. Run `node deployment/migrate-v2.mjs`. The pinned runner checks native
   migrations and completion independently of EverShop's exit code. Migration
   failure requires a fresh restore. Pending/processing legacy shipment rows
   are a blocking discrepancy because upstream may mark them as shipped.
5. Run `node deployment/adapt-store-content.mjs`. Review the reported packing
   placeholder; it is an explicitly unverified starter package, not a physical
   measurement. Set the returned ID as `MATERIAL_PUBLICATION_PACKAGE_ID`.
6. Run `node deployment/verify-baseline.mjs --baseline /private/before.private.json`.
   No lost or new orders, changed historic money, stock, payment receipts,
   credentials or shipment state are accepted. New columns are allowed.
   Exact native provider status aliases are accepted only with the original
   provider and migration-version proof (for example Stripe failed remains
   failed under its new provider-specific name). New CMS paths must derive
   exactly from original page UUIDs and URL keys; existing paths and CMS
   content remain protected. Older baselines lacking CMS hashes must be
   recaptured read-only from the original backup copy.
7. Check pages, category/product paths, redirects, mobile layout, icons offline,
   account-owned order payment links and an existing confirmed quote. Run only
   synthetic payment transitions in the dedicated test database; never register
   a receipt against a copied real order.

Price synchronization reads supplier LKR prices, recreates the source site's
two-decimal Resale USD display value, and stores it as admin source price.
Customers and newly created orders use the common 1.1 / upward .99 policy.
Historical orders are immutable. API stock is diagnostic only.

## Final switch

After candidate acceptance, briefly stop the old web writer and its job child.
Take another full database dump and copy current media/library/journals. Restore
into a separate final v2 database, repeat capture/migrate/adapt/verify, and only
then start the new pinned image on the existing public port. Preserve the old
container/image and original database. Exactly one app and job process may
write store data. Enable daily 09:00 price synchronization and Tuesday/Friday
10:00 two-style publication in Asia/Shanghai only after switching.

Validate health, order counts, the existing test order, customer payment access,
catalog prices and next scheduled job times. A link opening is not payment
acceptance. Shipment and bank receipt confirmations remain manual.

## Recovery

Before any new v2 orders or receipts, stopping v2 and restoring the saved old
container against its unchanged old database is reversible. After v2 has accepted
orders or receipts, first stop writers and save another v2 dump, media and journals.
Reconcile those new records before resuming an older database. Never discard new
orders by blindly replacing v2 with a stale backup; never run v1 against v2 schema.

## Upstream upgrades

Use `gh repo sync OKFred/one-shop --source evershopcommerce/evershop --branch dev`
to refresh the upstream tracking branch. Upgrade `shusha` through a dedicated PR
and restored database rehearsal. Review public exports, provider registries,
component aliases, schema and cron job contracts. The maintenance migration
runner references pinned native `dist/bin/lib` files because there is no public
migration API; this is a documented upgrade boundary, not a storefront dependency.

Keep GPLv3 and upstream attribution. Publish only reviewed source changes;
merchant data stays private. New upstream tags are not deployed automatically.
