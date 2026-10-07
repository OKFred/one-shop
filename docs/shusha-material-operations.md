# SHUSHA material operations on EverShop v2

The public repository contains adapters and synthetic fixtures only. Real source
responses, original images, reviewed style manifests, SKU maps, publication plans,
job journals and backups belong in private mounted directories.

## Runtime paths and jobs

| Setting | Default | Purpose |
| --- | --- | --- |
| `PRIVATE_DATA_DIR` | `<app>/data` | Private operations data |
| `MATERIAL_LIBRARY_DIR` | `<private data>/material-library` | Capture, READY reviews, explicit store map and job journals |
| `MATERIAL_MEDIA_DIR` | `<app>/media/source-library` | Hash-addressed original image files |
| `MATERIAL_PUBLICATION_BACKUP_DIR` | `<private data>/backups/material-publication` | Catalog snapshots and publication journals |
| `MATERIAL_PUBLICATION_MAP_PATH` | `<material library>/store-map.json` | Explicit SKU/source mapping; alternate paths must be inside the private publication backup directory |
| `MATERIAL_PUBLICATION_PACKAGE_ID` | No default | Merchant-selected native parcel definition for new shippable styles |

Mount candidate copies of private data and media into preview. Never share a
writable database, journal, SKU map or publication slot between v1 and v2.
Candidate/test/staging databases require an explicit private map path.

The native v2 job registry accepts `.js` modules: use the ESM wrappers
`scripts/jobs/source-sync.js` and `scripts/jobs/material-drop.js`. Worker logic
and the private journal runner remain CommonJS. Configure the shop timezone to
`Asia/Shanghai`; source sync runs at `0 9 * * *`, and material publication at
`0 10 * * 2,5`. Preview jobs remain disabled. Publication always requests two
styles for the Shanghai calendar date.

## Material capture and review

`node scripts/suusha-source.cjs --capture --new-arrivals 24` reads the authorized
public catalog without customer sessions or account operations. Follow with
`--download` using the normal bounded file and byte budget, then `--library-report`.
Capture and download do not publish. External unapproved gallery hosts remain
quarantined in the private report; inaccessible material never becomes READY.

A new style needs an explicit visual review of its actual category, SKU,
colour/size combinations, description omissions and original image gallery. Its
review note and timestamp are private. The reviewed source fingerprint must
match those facts, and all selected gallery images must exist as ordinary local
files with matching size and SHA-256. Price or stock refreshes preserve a visual
review; changed variants, copy or gallery invalidate it.

Source Resale prices remain source USD in the admin product table. The capture
adapter reproduces source display conversion for material evidence. Existing
catalog price writes use the authenticated backend adapter
`scripts/shusha-sync-prices.mjs`; the old `suusha-source.cjs --sync-prices` option
delegates to it and cannot fall back to the legacy catalog writer. Historical
orders are never repriced. The storefront/cart/new-order retail extension
applies the configured multiplier (default `1.1`) and the smallest `.99` at or
above that exact value.

## Publish and resume

1. Read the previous private job journal and check whether a publication is
   already active or completed. Never remove a lock merely because a run was slow.
2. Run `node scripts/publish-material-drop.cjs --publish-next --slot YYYY-MM-DD --limit 2 --dry-run`.
   The slot must be a Tuesday or Friday in Shanghai. A fresh batch needs exactly
   two READY styles; a smaller set cannot reserve the slot.
3. After review, use the same command with `--apply`. The database freezes the
   original plan before creating products. Retry with the **same slot and limit**.
4. Use `--verify` for that slot. A completed slot verifies its original plans and
   publishes nothing further. An unfinished earlier slot blocks reserving a new
   slot until its original journal is inspected and the run is resumed.

The publisher acquires a private adapter lock and both shared PostgreSQL advisory
locks, in publication then source-price order. It records snapshots and step
journals before writes. Native v2 public product/attribute services handle those
entities; a narrow owned SQL adapter handles variant group membership and
canonical URL rewrites because the native REST controllers are not public
package exports. Group creation and its publication reservation commit together.

Only new products receive request capacity `999`. Existing quantities, source
prices, UUIDs, SKU ownership and unrelated products are checked after publication.
Actual supplier availability, delivery cost and packing dimensions still require
merchant confirmation before payment/dispatch. A native seeded parcel may be
explicitly selected as a clearly labelled packing placeholder for the manual
freight flow; its dimensions are unverified and must not be used to promise
shipping rates or generate labels.

## Upgrade acceptance

Compile extension `src` trees into `dist` before a production build. Extension
code uses the published v2 package interfaces and leaves core source unchanged.
Verify the preserved legacy redirect ledger, public category/product URLs,
retail price filters/sorting, native cart calculation, and the transactional
`saveOrder` guard on a database copy before allowing real orders.

After native schema migration, run
`node deployment/adapt-store-content.mjs --dry-run --expected-database EXACT_TARGET`,
then `--apply` and `--verify` against the same isolated database. This adaptation
keeps existing CMS page and hero copy, moves the preserved main menu from the old
`header` area to `headerMiddleLeft`, and moves old `footer` placements to
`footerTop`. It preserves route, entity scope and sort order. Legacy menu list
fields and its main-menu boolean are normalized to v2 without recreating links.

Store branding is now the native `setting` rows `storeName`, `storeCurrency`,
`logo`, `logoWidth` and `logoHeight`; the former logo configuration alone cannot
populate the new header. The original private-media wordmark remains
`/assets/shusha/shusha-wordmark.svg`, intrinsically 200 × 40.

The adaptation renames only the untouched native starter `Standard Box` to
`Packing pending — manually confirm dimensions` and binds it to managed SHUSHA
products whose parcel is still NULL. It does not overwrite merchant-edited
packing records or invent verified measurements. The emitted parcel ID can be
used as `MATERIAL_PUBLICATION_PACKAGE_ID`. Product identities, source prices,
stock, historical order amounts and existing CMS copy are hashed in memory
before and after; drift aborts the single transaction. Output contains counts
and the parcel ID, without private CMS or customer data.

Run synthetic checks with:

```sh
node --test extensions/retail-pricing/tests/*.test.mjs \
  extensions/storefront-identity/tests/*.test.mjs \
  scripts/jobs/run.test.cjs scripts/tests/material-*.test.*
```
