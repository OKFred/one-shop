# Public company profile

Keep both storefronts' approved public details in one ignored file, `private/public-company-profile.json`. Start from [the empty template](public-company-profile.example.json); leave unknown fields empty. The shared loader validates the schema, public address, email and canonical HTTPS WhatsApp links. It has no fields for credentials, receiving accounts or registration documents.

`SHUSHA_PUBLIC_PROFILE_FILE` optionally selects a different file in a real `private` or `private-data` directory. The company-content CLI requires either this variable or `--profile` explicitly. Do not infer a legal company name or support email from the shop brand, a Wise account, the domain or an account owner's email.

## Before deploying a new image

Copy the real profile file privately into **both the isolated candidate and the production private mounts before starting the new image**. Set `SHUSHA_PUBLIC_PROFILE_FILE` when the mounted path differs from the default. Verify the mounted file is a regular file and the correct approved profile loads in each runtime; do not put it in Git, build arguments, image layers or public assets. Without the default file, the storefront falls back to the brand with empty contact fields, so the footer can lose its address and contact links. An explicitly configured missing or invalid file fails validation.

The public profile supplies the footer/contact card and company-page preparation. Native store settings are separate: use the authenticated EverShop settings UI for confirmed store name, phone, email and contact address, and review those changes independently. The CMS helper below does not update settings. It also does not change pricing, inventory, orders or payment instructions.

On Shopify, public company-page/theme contact fields are separate from the native shop's contact settings, legal entity, billing profile and fulfillment locations. **Do not overwrite Shopify's legal entity or billing address with a storefront contact address.** Review any native setting change in its own admin screen using confirmed facts; a public address does not establish registration, a showroom or opening hours.

## Update existing EverShop company pages

Use Node 22 with the native package compiled and private runtime `DB_*` variables. Take a fresh backup and rehearse against the isolated candidate first. All commands require the **exact connected database name**. The only permitted writes are the existing `about` and `contact` descriptions' name/content; UUIDs, status, layout, URL keys, SEO, rewrites, unrelated CMS and business tables are protected in one serializable transaction.

```sh
node deployment/apply-company-content.mjs --dry-run \
  --expected-database EXACT_ISOLATED_DATABASE \
  --profile private/public-company-profile.json

node deployment/apply-company-content.mjs --apply \
  --expected-database EXACT_ISOLATED_DATABASE \
  --profile private/public-company-profile.json \
  --expected-content-sha256 REVIEWED_DRY_RUN_SHA256

node deployment/apply-company-content.mjs --verify \
  --expected-database EXACT_ISOLATED_DATABASE \
  --profile private/public-company-profile.json
```

Dry run is the default. Review the public copy and use its `reviewContentSha256` for apply; a changed target page or profile invalidates that digest. `missing-pages` reports missing handles and blocks apply/verify: create the missing page through native CMS, preserve existing page identities, and run a fresh preview. The script never creates or publishes a page. Check active page status and desktop/mobile rendering separately; `--verify` confirms stored copy, not live appearance. Reports contain safe counts and hashes, not profile values or customer/payment rows.

## Prepare Shopify content and theme

Build the preparation input's `publicProfile` from the same validated file. Any separate support links must match it. `scripts/shopify/prepare-store.mjs` saves a private frozen plan with `preparedSha256`; review that plan, then apply with its exact hash. It re-reads the current source and shared profile before content writes. After any profile/CMS/source change, regenerate and review the plan and theme copy rather than reuse an old hash.

`--theme` creates a **private local theme copy** with the approved public settings. Keep the tracked theme's company settings empty. Theme generation and content apply are separate operations; neither publishes the live theme. Upload/preview only as an unpublished theme until the separately authorized visual acceptance and cutover. Do not treat a successful preparation or stored-copy check as proof of a published design.

If the native Shopify editor already has the approved `about` or `contact` page, do not create a replacement or silently take ownership. `scripts/shopify/adopt-public-pages.mjs --handles about,contact` prepares a private plan under `PRIVATE_DATA_DIR/shopify/adoption`. Review the selected native UUIDs, Shopify page identities and current public copy. Apply only that saved plan with `--apply --plan ORIGINAL_PRIVATE_PLAN --reviewed-sha256 EXACT_SHA256` and the existing bridge/content write flags. The helper associates the existing pages using owner metadata and private mappings; it does not change their body, title, handle, template or publication state.

Adoption uses the same content-sync lock and rechecks the source, public profile, remote pages and mappings before writing. A conflicting owner or changed page blocks the saved plan. If the owner write has an unknown outcome, retain its original frozen plan and journal: reconcile through fresh owner readback instead of sending the mutation again or preparing a replacement plan. Do not run normal content apply until the association and intended next content plan have been reviewed separately.

## Focused rehearsal

`tests/shusha/company-content.test.mjs` has two local checks and seven real PostgreSQL cases, including stale review/profile, missing pages, wrong database, protected-data contamination and complete rollback. Set `SHUSHA_COMPANY_CONTENT_TEST_DATABASE_URL` to a dedicated loopback database whose name ends in `_test`, then run:

```sh
node --test tests/shusha/company-content.test.mjs
```

The SQL cases are skipped when that private test variable is absent; confirm all nine pass with none skipped before claiming database rehearsal. Tests create and drop only their own synthetic schemas.
