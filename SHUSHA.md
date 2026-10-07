# SHUSHA on EverShop v2

The upstream branch is `dev`. The storefront branch is `shusha`, initially based on the stable `v2.2.1` tag. Keep upstream license notices. Use reviewed branches and pull requests for migration batches and future stable releases.

Merchant state belongs in private volume mounts and environment files. This public repository contains extensions, operational code, empty configuration templates, and synthetic tests. Supplier photos/snapshots, customer data, order records, actual receiving details, keys, and production reports stay private.

Source prices match SUUSHA's USD Resale display. The backend reads the authorized supplier price API using `SUUSHA_PRICE_API_KEY`, normalizes its LKR values with the source site's current display rate, and retains private provenance. Retail prices apply 1.1 and round upward to the smallest `.99`; price synchronization preserves inventory and historical orders.

Build with the pinned Node 22 image in `deployment/Dockerfile.shusha`. Migration instructions are in `docs/SHUSHA-MIGRATION.md`; supplier integration is documented in `docs/SUPPLIER-PRICES.md`.
