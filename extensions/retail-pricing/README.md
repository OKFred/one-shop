# SHUSHA retail pricing

The admin product table holds source USD. Managed `SHUSHA-` SKUs receive the
configured multiplier and the smallest `.99` at or above the exact result on the
storefront, price filters/sorting and native cart loader. Existing order amounts
are not transformed. The native `saveOrder` hook locks and compares the reviewed
cart snapshot, rejecting changed totals, currency, quantities or item prices.

EverShop v2.2.1 public exports are used throughout. Configure
`retailPricing: { enabled: true, multiplier: "1.1" }`, store currency USD and price
precision 2. Compile `src` into `dist` with the repository extension build before
production startup. See the material operations guide for source synchronization.
