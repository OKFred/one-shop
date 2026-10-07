# SHUSHA storefront brand

The extension supplies offline brand icons, the customer footer, compiled
hero/category styles, and a narrow storefront Logo page override.

The preserved SHUSHA SVG wordmark contains text. Native image optimization
converts it with Sharp, which renders missing-font boxes in the pinned Debian
slim image. For the exact existing SHUSHA wordmark asset path,
the override renders the original SVG directly in the browser, retaining the
home link, accessible label and intrinsic 200 × 40 dimensions. It leaves the
original asset unchanged and needs no server font installation. Other nonempty
logo assets use the publicly exported native `common/Image` component and its
responsive image proxy. A missing logo falls back to safe SHUSHA text.

EverShop v2's page scanner allows `pages/frontStore/all/Logo.js` to replace the
core page by its route/file key. This merchant brand page intentionally retains
the native settings query, layout and accessible home-link contract and uses
public component exports only. Review those props, query and area contracts
when upgrading. No upstream source file is modified.

After compiling, verify SSR and actual native page discovery without database,
HTTP, Sharp or installed server fonts:

```sh
node scripts/tests/native-logo-rendering.mjs
```
