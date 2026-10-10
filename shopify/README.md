# SHUSHA Shopify theme and content sync

The native Shopify theme lives in `theme/`. It is based on official Dawn v16.0.0, with the original Shopify license retained verbatim. That license grants MIT-style rights restricted to Shopify interoperability/themes; it is not unrestricted MIT. The theme remains an independent Shopify-only subtree; EverShop's GPLv3 notices are unchanged. Read [theme/UPSTREAM.md](theme/UPSTREAM.md) before upgrading Dawn.

The merchant layer follows the existing cream background, green buttons, split editorial hero, three category tiles, native product grids and mobile layout. Native Dawn handles variants, filtering, menus, cart forms and accessibility. Wise and WhatsApp icons use local SVG assets generated from the existing Iconify offline exports; no external icon service is called.

`snippets/shusha-courier-preference.liquid` submits the optional **Preferred courier** cart attribute with the native cart form, limited to 80 characters. Dynamic product and cart payment buttons are removed; drawer checkout routes to the full cart. The product page explains that shipping and payment follow manual confirmation. Public theme code contains no real bank details or Wise receiving URLs. The per-order authenticated payment flow belongs to the bridge application, not the theme.

## Private content and repeatable synchronization

`scripts/shopify/sync-content.mjs` exports `buildContentPlan`, `createContentSync`, `sanitizeContentHtml`, `computeCollectionMoves` and `writeMerchantThemeConfig`. Importing it performs no network calls and reads no credentials. Inject a server-side GraphQL client fixed to `2026-10`, plus a private durable store with `get(key)`, `put(key, value)` and `withLock(callback)` that serializes the whole shop synchronization. The lock must be shared by every worker using that shop. Supply `waitForJob(jobId, readJob)` to handle asynchronous collection changes; a pending job fails safely and requires readback on retry.

The content snapshot contract is:

```js
{
  products: [{ sourceUuid, handle, categoryHandle, shopifyGid, status: 'PUBLISHED', publishedAt }],
  pages: [{ sourceUuid, handle, title, bodyHtml }],
  collections: [{ sourceUuid, handle, title, descriptionHtml, productUuids: [] }],
  menus: [{ handle, title, items: [{ title, type: 'page' /* or collection, url */, handle, url, items: [] }] }],
  redirects: [{ path, target }]
}
```

Only products carrying an actual `PUBLISHED` source state, original publication date and verified Shopify GID enter collection membership or product redirects. READY and draft materials are excluded. The caller must derive that state from the current production catalog/store-map, never from the material library. Menus must use merchant-owned `shusha-*` handles. Pages and collections receive a hashed source identity metafield; collisions or changed IDs fail instead of overwriting unmanaged content. Lists are paginated, membership changes use bounded selection deltas, and manual ordering follows the source's newest publication first. Order changes are read back before acceptance. Redirects target only exported Shopify resources; native routes cannot be replaced. No products, customers, orders, inventory, historical money or notifications are changed by this module.

`sync(snapshot)` defaults to `dryRun: true`, and pages default to unpublished. To import reviewed content, pass `{ dryRun: false, publishPages: false }`. After acceptance, the operator can explicitly select `publishPages: true` for pages; keep that choice in private runtime configuration. Collections remain unpublished: this library never calls `publishablePublish`. Idempotency and lost-response recovery use current remote lookups, hashed ownership and durable private mappings. Repeating the same snapshot does not create duplicate resources. The caller must retain the mappings and recover the original operation under its lock after an unknown response.

CMS HTML allows basic semantic text, lists, tables and safe links. Embedded images, scripts, forms, iframes, event handlers, inline CSS and supplier widget markup are removed. Native sections and reviewed uploaded media carry the design instead. Empty input templates are in [theme/merchant-content.example.json](theme/merchant-content.example.json); fill a copy under `private/`, never this tracked file. `writeMerchantThemeConfig({themePath, outputPath, merchant})` generates a separate private theme copy with reviewed hero content, a native uploaded image and verified public WhatsApp links. Bank/receiving fields are deliberately absent.

## CLI verification and unpublished preview

Use official [Shopify CLI for themes](https://shopify.dev/docs/storefronts/themes/tools/cli). The CLI can authenticate as the store owner, through Theme Access, or with an authorized app token carrying the theme scopes. Keep tokens in runtime environment variables; never put them in commands, tracked config or documentation.

```powershell
$env:SHOPIFY_CLI_NO_ANALYTICS = '1'
npx --yes --registry https://registry.npmjs.org --package @shopify/cli@4.9.3 shopify theme check --path shopify/theme
# Use the generated private copy when merchant content has been injected.
shopify theme push --path <private-theme-copy> --store <authorized-shop> --unpublished
```

Do not add `--publish` or `--allow-live`. Keep the store password protected during preview. A syntactic theme check is not Shopify visual acceptance or proof that checkout can take orders. Desktop/mobile theme preview, native product variants, courier persistence, keyboard focus, the authenticated Wise entry, and operational acceptance must all pass before the merchant chooses a plan and opens orders.

Official GraphQL references: [pageCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/pageCreate), [collectionCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/collectionCreate), [collectionUpdate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/collectionUpdate), [menuCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/menuCreate), [urlRedirectCreate](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/urlRedirectCreate). The collection integration uses the 2026-10 `sources` API rather than the deprecated `CollectionInput.ruleSet`.
