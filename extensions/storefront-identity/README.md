# SHUSHA legacy routes

An exact private `shusha_legacy_path` ledger supplies permanent redirects for old
category and product URLs. Native v2 three-argument middleware runs after request
context and before authentication. It preserves raw query strings and a
single trailing-slash alias, rejects unsafe targets, and leaves admin/API/assets
requests alone. Missing optional ledger tables fall through; other database
errors reach the normal error handler.

Three fixed CMS aliases (`/page/how-to-order`, `/page/shipping-payment` and
`/page/contact`) redirect to the matching root-level page while preserving the
raw query string. They require no ledger access and do not change CMS content.
Other CMS paths retain native routing behavior.

Compile `src` into `dist` for production. Keep the ledger with the migrated
database so old links continue to reach canonical SHUSHA category/product paths.
