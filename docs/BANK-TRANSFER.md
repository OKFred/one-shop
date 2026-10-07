# SHUSHA manual payments on EverShop v2

The `bank-transfer` extension uses EverShop's public shipping and payment
registries. `shusha` / `manual_quote` returns a zero-cost provisional shipping
method in USD, expressly labelled **Shipping quotation pending**. Other payment
and shipping factories remain installed but cannot be selected while this mode
is enabled. New requests start with payment and shipment `pending`.

## Private configuration

Set `SHUSHA_WISE_RECEIVING_CONFIG` to an absolute, read-only mounted JSON file
outside this repository and image. Keep issued bank details and the real Wise
Business open link there. The file format is `{ "openLink": null, "accounts": {} }`;
each configured currency entry contains `fields: [{ "label": "...", "value": "..." }]`.
Only verified GBP/EUR accounts are accepted by default; `allowUsd: true` is an
explicit assertion that USD receiving details have actually been issued.
No Wise API token is required or sent by this extension.

The admin confirms availability and a receiving-currency amount on each order.
USD quotes must equal the original merchandise total; GBP/EUR are explicit
manual conversion quotes. This does not change the USD order total. Opening a
Wise link never confirms a payment. Actual receipt confirmation is an explicit
admin action with exact amount, currency, quote revision and unique bank receipt
reference, committed with the native payment transition in one transaction.
Neither quote confirmation nor receipt registration sends customer messages.
EverShop's automatic order confirmation, customer welcome, shipment-created and
shipment-delivered notifications are disabled through its native
`system.notification_emails.<type>.enabled=false` settings. The extension sets
these defaults and fails startup if configuration enables any of them. Native
stock and catalog event subscribers remain intact. No replacement email service
reports a suppressed notification as sent. Customer-initiated password resets
are a separate native flow.

## Customer access and icons

`/payment/:orderUuid` preserves old UUID links as bearer capabilities. Its
dedicated GraphQL type exposes only order number and payment instructions, not
customer identities or addresses. Account pages and order detail show payment
instructions only for authenticated, customer-owned orders. These pages and
GraphQL responses use private/no-store, noindex and no-referrer headers.
Native cart/order summary components are wrapped through public component
exports to label shipping as **To be confirmed** and totals as merchandise-only.
The success-page override removes the native assumption that an email receipt
was sent. These three component boundaries must be reviewed on upstream upgrades.

`BrandIcon` is exported as `@shusha/bank-transfer/components/BrandIcon`, with
`brand="wise"` or `brand="whatsapp"` and optional `size` (default 20). Icons are
decorative beside visible text. The two Simple Icons (CC0-1.0) are bundled as
local icon data and rendered using Iconify's offline component; there is no
runtime icon API request. Upstream sources:

- https://iconify.design/docs/icon-components/react/
- https://simpleicons.org/
- https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md

## Database migration and acceptance

The existing `shusha_payment_quote`, audit and receipt tables retain their schema
and IDs. Extension migration `1.0.1` runs after core v2 migrations, creates its own
worldwide quote zone and corrects core's legacy `manual_quote` provider backfill
to `shusha`, without rewriting amounts, quote versions or shipment state.
Persisted carts must select the new method again if their old provider snapshot
was incorrectly backfilled as Core.

Before core migrations, capture the original orders and full shipment rows in a
private baseline. Core OMS migration `1.0.3` turns shipment rows associated with
`pending`/`processing` orders into `shipped`. Any such rows must be reviewed:
the new model only permits shipment rows for actual dispatch. Do not accept a
silent pending-to-shipped conversion. Reconcile against the private snapshot
and verify order and item rollups before traffic switches. A deployment must
fail its acceptance gate until this discrepancy is resolved.

Run `npm run test --workspace=@shusha/bank-transfer` for validation, privacy
capability and offline SVG tests. The integration harness requires all core and
extension builds, an explicitly isolated DB, `BANK_TRANSFER_TEST_ALLOW_WRITE=1`
and `BANK_TRANSFER_TEST_DB=DB_NAME` with a test/candidate/integration database
name. It creates and cleans up synthetic orders; it never registers a receipt
for a copied real order or calls a payment provider.
