# SHUSHA maintenance

This is a public native fork. Keep `dev` aligned with upstream; merchant changes live on `shusha` and reviewed feature branches.

- Preserve upstream GPLv3 notices. Prefer documented extension exports; core patches require an explicit compatibility note and focused regression coverage.
- Never commit credentials, supplier snapshots/photos, customer/order data, real receiving details, deployment environments, backups, or production diagnostics. Use synthetic fixtures and empty templates. Scan the pending diff and uploaded history before pushing.
- Merchandise source price is the supplier's USD Resale display value. Store native product prices remain source USD; storefront/cart/new orders apply 1.1 and the smallest n.99 at least equal to the marked-up value. Historical orders are immutable under price sync.
- Source API credentials are backend environment variables. Price sync never updates stock. New material publication requires a reviewed, hash-verified READY record and preserves the original publication slot on retry.
- Rehearse migrations on a restored database and isolated media/task copies. Never let v1 and v2 write one database. Snapshot legacy pending shipments before native migrations and reconcile before exposing checkout.
- Keep operated PVE/Cockpit/terminal browser pages open with the browser tool's turn-scoped deliverable/handoff marker.
