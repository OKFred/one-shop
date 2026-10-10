# Dawn source and compatibility

Vendored from the official [Shopify/dawn](https://github.com/Shopify/dawn/tree/v16.0.0), tag `v16.0.0`, commit `bc39a7d2024f1e5c14c42f855bd3552b4913e204`. The original Shopify license is retained verbatim in LICENSE.md. It grants MIT-style rights with a Shopify interoperability/use restriction; it is not an unrestricted MIT license. This independent theme subtree is for Shopify only and does not change EverShop's GPLv3 notices. This directory contains no embedded Git checkout.

Merchant code is isolated in `shusha-*` assets, sections and snippets. Native Dawn product variants, collection filtering, menus, cart forms and accessibility remain in use. The small upstream patches are:

- `layout/theme.liquid`: load the local merchant stylesheet.
- `snippets/buy-buttons.liquid`: suppress dynamic payment buttons and display the order request notice.
- `sections/main-cart-footer.liquid`: include the cart attribute and suppress accelerated checkout.
- `snippets/cart-drawer.liquid`: route the drawer checkout entry to the full cart so the preference cannot be skipped.
- Native JSON templates and settings select merchant sections, page cart and no quick add.

Review these patches on every Dawn update. Do not copy remote theme settings back into Git: they can contain merchant content and image identifiers. Public templates contain no supplier images, account numbers or receiving links. Local Wise and WhatsApp SVGs come from the existing Iconify offline Simple Icons exports (CC0-1.0); brand usage rules still apply.

Upload only an unpublished theme with Shopify CLI. A theme is not proof of operational checkout: manual payment configuration, app authorization, quote access, currency and all acceptance gates must pass before opening orders.
