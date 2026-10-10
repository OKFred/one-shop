import { integer, applyShopifySnapshot, freezeSku } from './inventory.js';
import { withTransaction } from './outbox.js';

function identifier(value, type) {
  const text = String(value ?? '');
  if (new RegExp(`^gid://shopify/${type}/[0-9]+$`).test(text)) return text;
  if (/^[0-9]+$/.test(text)) return `gid://shopify/${type}/${text}`;
  throw new Error(`Invalid Shopify ${type} identifier`);
}
function money(value) {
  const text = String(value ?? '');
  if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(text)) throw new Error('Invalid native order amount');
  const [whole, decimal = ''] = text.split('.');
  return `${whole}.${decimal.padEnd(2, '0')}`;
}
function instant(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Order source timestamp is required');
  return date.toISOString();
}

export function pendingTrustedCancellation(record, id) {
  return record?.kind === 'order-cancel' && record.orderId === id && record.merchantConfirmed === true &&
    typeof record.shop === 'string' && /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(record.shop) &&
    ['prepared','in-flight','pending','unknown','review'].includes(record.status) &&
    record.input?.orderId === id && record.input.restock === true && record.input.notifyCustomer === false &&
    record.input.refundMethod?.originalPaymentMethodsRefund === false &&
    /^[a-f0-9]{64}$/.test(record.inputHash || '') && /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(record.operationKey || '');
}

/** Only order data needed for operations is retained, never an entire customer payload. */
export function normalizeShopifyOrder(payload, { restockEvidence = {} } = {}) {
  const rawLines = Array.isArray(payload.line_items) ? payload.line_items : payload.lineItems?.nodes;
  if (!Array.isArray(rawLines) || rawLines.length > 1000 || payload.lineItems?.pageInfo?.hasNextPage) {
    throw new Error('A complete bounded order line snapshot is required');
  }
  const canceled = Boolean(payload.cancelled_at || payload.cancelledAt);
  const refunds = new Map();
  const refundKeys = new Set();
  for (const refund of payload.refunds ?? []) {
    if (refund.refundLineItems?.pageInfo?.hasNextPage) throw new Error('Complete refund restock evidence is required');
    const refundLines = refund.refund_line_items ?? refund.refundLineItems?.nodes ?? [];
    for (const [index, line] of refundLines.entries()) {
      // GraphQL permits a null RefundLineItem ID. Distinct such lines still
      // release their own original line, even inside the same refund.
      const key = `${refund.id}:${line.id ?? `position:${index}`}`;
      if (refundKeys.has(key)) continue;
      refundKeys.add(key);
      if (!['return', 'cancel'].includes(String(line.restock_type ?? line.restockType).toLowerCase()) || line.restocked === false) continue;
      const lineId = identifier(line.line_item_id ?? line.lineItem?.id, 'LineItem');
      const quantity = integer(line.quantity);
      if (quantity < 0) throw new Error('Invalid refund line quantity');
      refunds.set(lineId, (refunds.get(lineId) ?? 0) + quantity);
    }
  }
  const lines = rawLines.map((raw) => {
    const id = identifier(raw.id, 'LineItem');
    if (typeof raw.sku !== 'string' || !raw.sku || raw.sku.length > 200) throw new Error('Shopify order line needs its mapped SKU');
    const quantity = integer(raw.quantity);
    const explicitRelease = restockEvidence[id];
    const releasedQuantity = explicitRelease === undefined ? (refunds.get(id) ?? 0) : integer(explicitRelease);
    if (quantity < 0 || releasedQuantity < 0 || releasedQuantity > quantity) throw new Error('Invalid native restock evidence');
    const currentQuantity = raw.current_quantity ?? raw.currentQuantity ?? quantity;
    return { id, sku: raw.sku, quantity, currentQuantity: integer(currentQuantity), releasedQuantity,
      releaseAmbiguous: canceled && releasedQuantity < quantity && explicitRelease === undefined };
  });
  if (new Set(lines.map((line) => line.id)).size !== lines.length) throw new Error('Duplicate native order lines');
  const currency = payload.currency ?? payload.currencyCode;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid native order currency');
  const number = String(payload.name ?? payload.order_number ?? payload.id);
  if (number.length > 100) throw new Error('Invalid native order number');
  const preference = (payload.note_attributes ?? payload.customAttributes ?? []).find((attribute) =>
    ['preferred_courier', 'shusha_shipping_preference', 'Preferred courier'].includes(attribute.name ?? attribute.key))?.value;
  return {
    platform: 'shopify', id: identifier(payload.admin_graphql_api_id ?? payload.id, 'Order'), number, currency,
    total: money(payload.current_total_price ?? payload.currentTotalPriceSet?.shopMoney?.amount ?? payload.total_price),
    paymentStatus: String(payload.financial_status ?? payload.displayFinancialStatus ?? 'unknown'),
    fulfillmentStatus: String(payload.fulfillment_status ?? payload.displayFulfillmentStatus ?? 'unfulfilled'),
    canceled, updatedAt: instant(payload.updated_at ?? payload.updatedAt), lines,
    preferredCourier: typeof preference === 'string' ? preference.slice(0, 100) : null
  };
}

/** Persist business effects together with the order mirror; webhook inbox owns delivery dedupe. */
export async function ingestShopifyOrder(pool, payload, options = {}) {
  const order = options.normalized === true ? payload : normalizeShopifyOrder(payload, options);
  if (order.platform !== 'shopify') throw new Error('Shopify adapter cannot ingest a different platform');
  if (order.canceled && order.lines.some((line) => line.releaseAmbiguous)) {
    const record = (await pool.query(`SELECT record FROM shusha_bridge_mapping WHERE kind='operation' AND source_key=$1`, [`order-restock:${order.id}`])).rows[0]?.record;
    if (pendingTrustedCancellation(record, order.id)) return { deferred: true, effects: false };
  }
  return withTransaction(pool, async (connection) => {
    // Works even for the first two simultaneous deliveries, before a row exists.
    await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shusha:order:${order.id}`]);
    const prior = (await connection.query(`SELECT * FROM shusha_bridge_orders WHERE platform='shopify' AND order_id=$1 FOR UPDATE`, [order.id])).rows[0];
    if (prior && new Date(prior.source_updated_at).getTime() > new Date(order.updatedAt).getTime()) return { stale: true, effects: false };
    // Shopify has no uncancel operation. An equal-second late create delivery
    // must not make a known canceled native order appear payable again.
    if (prior?.canceled && !order.canceled) return { stale: true, effects: false };
    const previousLines = (await connection.query(`SELECT line_id,sku,consumed_qty,released_qty FROM shusha_bridge_order_line
      WHERE platform='shopify' AND order_id=$1`, [order.id])).rows;
    for (const previous of previousLines) {
      const line = order.lines.find((current) => current.id === previous.line_id);
      if (!line || (line.quantity < integer(previous.consumed_qty) && line.releasedQuantity <= integer(previous.released_qty))) {
        await freezeSku(connection, previous.sku, 'shopify-line-edit-restock-evidence-required');
      }
    }
    await applyShopifySnapshot(connection, order);
    const snapshot = { lines: order.lines, preferredCourier: order.preferredCourier };
    await connection.query(`INSERT INTO shusha_bridge_orders
      (platform,order_id,number,currency,total,payment_status,fulfillment_status,canceled,source_updated_at,private_snapshot)
      VALUES('shopify',$1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(platform,order_id) DO UPDATE SET
      number=EXCLUDED.number,currency=EXCLUDED.currency,total=EXCLUDED.total,payment_status=EXCLUDED.payment_status,
      fulfillment_status=EXCLUDED.fulfillment_status,canceled=EXCLUDED.canceled,source_updated_at=EXCLUDED.source_updated_at,
      private_snapshot=EXCLUDED.private_snapshot,updated_at=NOW()`,
    [order.id, order.number, order.currency, order.total, order.paymentStatus, order.fulfillmentStatus, order.canceled, order.updatedAt, JSON.stringify(snapshot)]);
    return { stale: false, effects: true, lineCount: order.lines.length, requiresReview: order.lines.some((line) => line.releaseAmbiguous) };
  });
}

/** Read native orders through separate adapters; never synthesize an EverShop order. */
export async function listUnifiedOrders(pool, { platform = 'all', limit = 30, offset = 0 } = {}) {
  if (!['all', 'evershop', 'shopify'].includes(platform) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Invalid unified order filter');
  }
  const native = `SELECT 'evershop'::text AS platform,order_id::text AS order_id,order_number::text AS number,
    uuid::text AS native_uuid,currency,grand_total::text AS total,payment_status,shipment_status AS fulfillment_status,
    status IN ('canceled','cancelled') AS canceled,created_at,updated_at FROM "order"`;
  const shopify = `SELECT platform,order_id,number,NULL::text AS native_uuid,currency,total::text,payment_status,
    fulfillment_status,canceled,created_at,updated_at FROM shusha_bridge_orders WHERE platform='shopify'`;
  const query = platform === 'all' ? `${native} UNION ALL ${shopify}` : platform === 'evershop' ? native : shopify;
  return (await pool.query(`SELECT * FROM (${query}) orders ORDER BY created_at DESC,platform,order_id LIMIT $1 OFFSET $2`, [limit, offset])).rows;
}

export async function getUnifiedOrder(pool, platform, orderId) {
  if (platform === 'evershop') {
    if (!/^[0-9]+$/.test(String(orderId))) throw new Error('Invalid EverShop order identifier');
    const order = (await pool.query(`SELECT order_id,uuid,order_number,currency,grand_total,payment_status,shipment_status,status,
      shusha_shipping_preference,created_at,updated_at FROM "order" WHERE order_id=$1`, [orderId])).rows[0];
    if (!order) return null;
    const lines = (await pool.query(`SELECT order_item_id,product_sku,product_name,qty,final_price FROM order_item WHERE order_item_order_id=$1`, [orderId])).rows;
    return { platform, native: order, lines };
  }
  if (platform !== 'shopify') throw new Error('Invalid order platform');
  const id = identifier(orderId, 'Order');
  const order = (await pool.query(`SELECT * FROM shusha_bridge_orders WHERE platform='shopify' AND order_id=$1`, [id])).rows[0];
  return order ? { platform, native: order, lines: order.private_snapshot.lines } : null;
}

const ORDER_HYDRATE_QUERY = `query BridgeOperationalOrder($id:ID!,$after:String){
  order(id:$id){id name currencyCode updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus
    currentTotalPriceSet{shopMoney{amount currencyCode}} customAttributes{key value}
    lineItems(first:250,after:$after){pageInfo{hasNextPage endCursor} nodes{id sku quantity currentQuantity}}
    refunds{id refundLineItems(first:250){pageInfo{hasNextPage} nodes{id quantity restockType restocked lineItem{id}}}}
  }
}`;

export async function hydrateShopifyOrder(client, orderId) {
  const id = identifier(orderId, 'Order');
  let snapshot; let after = null; const lines = [];
  for (let page = 0; page < 4; page += 1) {
    const raw = (await client.request(ORDER_HYDRATE_QUERY, { id, after })).order;
    if (!raw || !Array.isArray(raw.lineItems?.nodes)) throw new Error('Authoritative Shopify order is unavailable');
    if (snapshot && raw.updatedAt !== snapshot.updatedAt) throw new Error('Shopify order changed during hydration; retry complete snapshot');
    snapshot ??= raw;
    if (!Array.isArray(raw.refunds) || raw.refunds.length > 100 || raw.refunds.some((refund) => refund.refundLineItems?.pageInfo?.hasNextPage)) {
      throw new Error('Order refund evidence exceeds the bounded complete snapshot');
    }
    lines.push(...raw.lineItems.nodes);
    if (!raw.lineItems.pageInfo.hasNextPage) return { ...snapshot, lineItems: { nodes: lines, pageInfo: { hasNextPage: false } } };
    const next = raw.lineItems.pageInfo.endCursor;
    if (!next || next === after) throw new Error('Order line hydration cursor did not advance');
    after = next;
  }
  throw new Error('Order exceeds the bounded complete line snapshot');
}

const ORDER_SCAN_QUERY = `query BridgeRecentOrders($after:String,$filter:String!){
  orders(first:50,after:$after,sortKey:UPDATED_AT,query:$filter){pageInfo{hasNextPage endCursor} nodes{
    id
  }}
}`;

/** Scheduled gap fill reads recent native facts, never an inventory reset. */
export async function reconcileRecentOrders(pool, { client, since, maxPages = 20, now = Date.now, readAllOrders = false } = {}) {
  if (!client?.request || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid order reconciliation adapter');
  const earliest = now() - 60 * 86400000;
  const requested = since === undefined ? now() - 3600000 : new Date(since).getTime();
  if (!Number.isFinite(requested)) throw new Error('Invalid order reconciliation timestamp');
  const start = !readAllOrders ? Math.max(requested, earliest) : requested;
  const filter = `updated_at:>=${new Date(start).toISOString()}`;
  let after = null; let orders = 0; let deferred = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await client.request(ORDER_SCAN_QUERY, { after, filter });
    if (!Array.isArray(data?.orders?.nodes)) throw new Error('Order reconciliation response is incomplete');
    for (const raw of data.orders.nodes) {
      const payload = await hydrateShopifyOrder(client, raw.id);
      // Deliberate merchant cancellations retain independently completed native
      // restock proof even when Shopify has no refund line for that operation.
      const saved = (await pool.query(`SELECT record FROM shusha_bridge_mapping WHERE kind='operation' AND source_key=$1`,
        [`order-restock:${identifier(payload.id, 'Order')}`])).rows[0]?.record;
      const effect = await ingestShopifyOrder(pool, payload, { restockEvidence: saved?.status === 'complete' ? (saved.restockEvidence || {}) : {} });
      if (effect.deferred) deferred += 1;
      orders += 1;
    }
    if (!data.orders.pageInfo?.hasNextPage) return { orders, deferred, pages: page + 1, complete: deferred === 0, olderOrdersRequireNativeAdmin: !readAllOrders && requested < earliest };
    if (!data.orders.pageInfo.endCursor || data.orders.pageInfo.endCursor === after) throw new Error('Order reconciliation cursor did not advance');
    after = data.orders.pageInfo.endCursor;
  }
  return { orders, deferred, pages: maxPages, complete: false, olderOrdersRequireNativeAdmin: !readAllOrders && requested < earliest };
}

/** Verify differences using outstanding delta intents; never repair by assigning a quantity. */
const CAPACITY_FACTS = `SELECT b.*,i.qty AS native_qty,
  COALESCE((SELECT SUM((payload->>'delta')::bigint) FROM shusha_bridge_outbox
    WHERE aggregate_key=b.sku AND state<>'applied' AND kind='inventory.evershop'),0)::text AS native_pending,
  COALESCE((SELECT SUM((payload->>'delta')::bigint) FROM shusha_bridge_outbox
    WHERE aggregate_key=b.sku AND state<>'applied' AND kind='inventory.shopify'),0)::text AS remote_pending,
  (SELECT COUNT(*) FROM shusha_bridge_outbox WHERE aggregate_key=b.sku AND kind='inventory.shopify'
    AND request_json IS NOT NULL AND state<>'applied')::int AS unresolved_remote,
  (SELECT COUNT(*) FROM shusha_bridge_ledger WHERE sku=b.sku)::int AS ledger_count
  FROM shusha_bridge_inventory b JOIN product_inventory i ON i.product_inventory_product_id=b.product_id`;
const capacitySignature = (row) => JSON.stringify([row.balance, row.native_qty, row.shopify_debt, row.native_pending, row.remote_pending, row.ledger_count]);

export async function auditCapacity(pool, { readShopifyQuantity, resolveInventory, now = Date.now } = {}) {
  const inventory = (await pool.query(`${CAPACITY_FACTS} ORDER BY b.sku`)).rows;
  let checked = 0; let frozen = 0; let pendingReview = 0;
  for (const row of inventory) {
    if (row.frozen) { checked += 1; continue; }
    let remote;
    // A response-lost write may already exist remotely; never diagnose it by guessing.
    if (typeof readShopifyQuantity === 'function' && typeof resolveInventory === 'function' && !row.unresolved_remote) {
      remote = integer(await readShopifyQuantity(await resolveInventory(row.sku)));
    }
    const outcome = await withTransaction(pool, async (connection) => {
      await connection.query('SELECT sku FROM shusha_bridge_inventory WHERE sku=$1 FOR UPDATE', [row.sku]);
      // One MVCC statement reads native balance, central balance and its pending deltas.
      const current = (await connection.query(`${CAPACITY_FACTS} WHERE b.sku=$1`, [row.sku])).rows[0];
      if (integer(current.native_qty) + integer(current.native_pending) !== integer(current.balance)) {
        await freezeSku(connection, row.sku, 'unexplained-native-capacity-difference'); return 'frozen';
      }
      if (remote === undefined || current.unresolved_remote || capacitySignature(current) !== capacitySignature(row)) return 'changed';
      const waitingDelivery = (await connection.query("SELECT COUNT(*)::int AS count FROM shusha_bridge_inbox WHERE state='pending'")).rows[0].count;
      if (waitingDelivery) return 'changed';
      const key = `capacity-audit:${row.sku}`;
      if (remote - integer(current.shopify_debt) + integer(current.remote_pending) === integer(current.balance)) {
        await connection.query("DELETE FROM shusha_bridge_mapping WHERE kind='operation' AND source_key=$1", [key]); return 'consistent';
      }
      const signature = `${capacitySignature(current)}:${remote}`;
      const previous = (await connection.query("SELECT record FROM shusha_bridge_mapping WHERE kind='operation' AND source_key=$1 FOR UPDATE", [key])).rows[0]?.record;
      if (previous?.signature === signature && now() - new Date(previous.observedAt).getTime() >= 15 * 60000) {
        await freezeSku(connection, row.sku, 'unexplained-shopify-capacity-difference'); return 'frozen';
      }
      const observation = { signature, observedAt: previous?.signature === signature ? previous.observedAt : new Date(now()).toISOString() };
      await connection.query(`INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('operation',$1,$2)
        ON CONFLICT(kind,source_key) DO UPDATE SET record=EXCLUDED.record,updated_at=NOW()`, [key, JSON.stringify(observation)]);
      return 'pending-review';
    });
    if (outcome === 'frozen') frozen += 1;
    if (outcome === 'pending-review') pendingReview += 1;
    checked += 1;
  }
  return { checked, newlyFrozen: frozen, pendingReview, reset: false };
}
