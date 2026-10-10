import { randomUUID } from 'node:crypto';
import { enqueue } from './outbox.js';

export function integer(value, name = 'quantity') {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^-?\d+$/.test(value))) {
    throw new Error(`Invalid ${name}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${name}`);
  return number;
}

export function requireTransaction(connection) {
  if (!connection?.query || connection.INTRANSACTION !== true) {
    throw new Error('Bridge inventory requires the caller-owned order transaction');
  }
}

/** Shopify cannot expose the negative request capacity. Preserve it as debt. */
export function projectShopifyDelta(quantity, debt, delta) {
  quantity = integer(quantity); debt = integer(debt, 'debt'); delta = integer(delta);
  if (debt < 0) throw new Error('Invalid debt');
  const effective = integer(quantity - debt + delta);
  const nextQuantity = Math.max(0, effective);
  return { quantity: nextQuantity, debt: Math.max(0, -effective), delta: nextQuantity - quantity };
}

/** One opening per SKU, under its native row write barrier; never a stock reset. */
export async function openCapacity(connection, { skus }) {
  requireTransaction(connection);
  if (!Array.isArray(skus) || !skus.length || skus.some((sku) => typeof sku !== 'string' || !sku)) {
    throw new Error('Explicit mapped SKUs are required for opening capacity');
  }
  const source = await connection.query(`SELECT p.product_id,p.sku,i.qty,i.manage_stock
    FROM product p JOIN product_inventory i ON i.product_inventory_product_id=p.product_id
    WHERE p.sku=ANY($1::text[]) ORDER BY p.product_id FOR UPDATE OF i`, [[...new Set(skus)]]);
  if (source.rows.length !== new Set(skus).size || source.rows.some((row) => !row.manage_stock)) {
    throw new Error('Every opening SKU must exist and use native managed stock');
  }
  let opened = 0;
  for (const row of source.rows) {
    const inserted = await connection.query(`INSERT INTO shusha_bridge_inventory
      (sku,product_id,balance,shopify_debt) VALUES($1,$2,$3,0)
      ON CONFLICT(sku) DO NOTHING RETURNING sku`, [row.sku, row.product_id, integer(row.qty)]);
    if (!inserted.rowCount) continue;
    opened += 1;
    await enqueue(connection, { intentKey: `inventory-opening:${row.sku}`, kind: 'inventory.shopify', aggregateKey: row.sku,
      payload: { sku: row.sku, delta: integer(row.qty), opening: true } });
    // Existing pending deductions are already included in the opening balance.
    // Their original immutable line quantities are the only permitted release basis.
    await connection.query(`INSERT INTO shusha_bridge_order_line
      (platform,order_id,line_id,sku,consumed_qty,released_qty,legacy)
      SELECT 'evershop',o.order_id::text,oi.order_item_id::text,$1,oi.qty,0,TRUE
      FROM order_item oi JOIN "order" o ON o.order_id=oi.order_item_order_id
      WHERE oi.product_id=$2 AND oi.qty>0 AND COALESCE(o.status,'') NOT IN ('canceled','cancelled')
      AND COALESCE(o.payment_status,'') NOT IN ('canceled','cancelled')
      AND COALESCE(o.shipment_status,'') NOT IN ('canceled','cancelled','delivered')
      ON CONFLICT(platform,order_id,line_id) DO NOTHING`, [row.sku, row.product_id]);
  }
  return { opened, reset: false };
}

export async function freezeSku(connection, sku, reason) {
  await connection.query(`UPDATE shusha_bridge_inventory SET frozen=TRUE,freeze_reason=$2 WHERE sku=$1`, [sku, reason]);
}

/** BEFORE saveOrderItems: lock native rows before central rows and reject paused capacity. */
export async function beforeNativeOrder(connection, cart) {
  requireTransaction(connection);
  if (typeof cart?.getItems !== 'function') throw new Error('Native cart items are required');
  const requested = new Map();
  for (const item of cart.getItems()) {
    if (typeof item?.getData !== 'function') throw new Error('Native cart item data is required');
    const sku = item.getData('product_sku'); const quantity = integer(item.getData('qty'));
    if (typeof sku !== 'string' || !sku || quantity <= 0) throw new Error('Invalid native cart capacity request');
    requested.set(sku, integer((requested.get(sku) ?? 0) + quantity));
  }
  const mapped = (await connection.query(`SELECT DISTINCT v->>'sku' AS sku FROM shusha_bridge_mapping m,
    LATERAL jsonb_array_elements(COALESCE(m.record->'variants','[]'::jsonb)) v
    WHERE m.kind='product' AND v->>'sku'=ANY($1::text[]) ORDER BY sku`, [[...requested.keys()]])).rows;
  if (!mapped.length) return { guarded: 0 };
  const native = (await connection.query(`SELECT p.product_id,p.sku,i.qty,i.manage_stock FROM product p
    JOIN product_inventory i ON i.product_inventory_product_id=p.product_id
    WHERE p.sku=ANY($1::text[]) ORDER BY p.product_id FOR UPDATE OF i`, [mapped.map((row) => row.sku)])).rows;
  if (native.length !== mapped.length || native.some((row) => !row.manage_stock)) throw new Error('Mapped native inventory requires investigation');
  const capacities = new Map((await connection.query(`SELECT sku,balance,frozen FROM shusha_bridge_inventory
    WHERE sku=ANY($1::text[]) ORDER BY sku FOR UPDATE`, [native.map((row) => row.sku)])).rows.map((row) => [row.sku, row]));
  for (const row of native) {
    const capacity = capacities.get(row.sku);
    if (!capacity) throw new Error('Mapped shared capacity has not been opened');
    if (capacity.frozen) throw new Error('This style is temporarily paused for inventory review');
    if (integer(capacity.balance) < requested.get(row.sku) || integer(row.qty) < requested.get(row.sku)) {
      throw new Error('The requested shared capacity is no longer available');
    }
  }
  return { guarded: native.length };
}

async function ledgerDelta(connection, { platform, orderId, lineId, sku, delta, businessKey, reason }) {
  requireTransaction(connection);
  delta = integer(delta);
  if (!delta) return false;
  const inventory = (await connection.query('SELECT * FROM shusha_bridge_inventory WHERE sku=$1 FOR UPDATE', [sku])).rows[0];
  if (!inventory) throw new Error('Order contains an unopened shared-capacity SKU');
  const ledgerId = randomUUID();
  const inserted = await connection.query(`INSERT INTO shusha_bridge_ledger
    (id,business_key,sku,platform,order_id,line_id,delta,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(business_key) DO NOTHING RETURNING id`, [ledgerId, businessKey, sku, platform, String(orderId), String(lineId), delta, reason]);
  if (!inserted.rowCount) return false;
  await connection.query('UPDATE shusha_bridge_inventory SET balance=balance+$2 WHERE sku=$1', [sku, delta]);
  await enqueue(connection, {
    intentKey: `inventory:${ledgerId}`, kind: platform === 'evershop' ? 'inventory.shopify' : 'inventory.evershop',
    aggregateKey: sku, payload: { sku, delta, ledgerId }
  });
  if (platform === 'shopify') {
    // A native Shopify cancellation can increase available while debt exists.
    // Normalize that native quantity through CAS without adding a second
    // central effect: the returned units repay debt before becoming sellable.
    await enqueue(connection, { intentKey: `inventory-normalize:${ledgerId}`, kind: 'inventory.shopify', aggregateKey: sku,
      payload: { sku, delta: 0, ledgerId, debtNormalize: true } });
  }
  return true;
}

/** AFTER saveOrderItems: native SQL trigger has already deducted these lines. */
export async function recordNativeOrder(connection, orderId) {
  requireTransaction(connection);
  const lines = (await connection.query(`SELECT oi.order_item_id,oi.qty,p.sku FROM order_item oi
    JOIN product p ON p.product_id=oi.product_id JOIN shusha_bridge_inventory b ON b.sku=p.sku
    WHERE oi.order_item_order_id=$1 ORDER BY p.sku,oi.order_item_id`, [orderId])).rows;
  for (const line of lines) {
    const quantity = integer(line.qty);
    if (quantity <= 0) throw new Error('Invalid native order quantity');
    const saved = await connection.query(`INSERT INTO shusha_bridge_order_line
      (platform,order_id,line_id,sku,consumed_qty,released_qty,legacy) VALUES('evershop',$1,$2,$3,$4,0,FALSE)
      ON CONFLICT(platform,order_id,line_id) DO NOTHING RETURNING line_id`, [String(orderId), String(line.order_item_id), line.sku, quantity]);
    if (!saved.rowCount) continue;
    await ledgerDelta(connection, { platform: 'evershop', orderId, lineId: line.order_item_id, sku: line.sku,
      delta: -quantity, businessKey: `evershop:${orderId}:${line.order_item_id}:consume`, reason: 'order-created' });
  }
  return { lines: lines.length };
}

/** Lock BEFORE native cancellation changes status or restocks. */
export async function beforeNativeCancel(connection, orderId) {
  requireTransaction(connection);
  const order = (await connection.query('SELECT status,payment_status,shipment_status FROM "order" WHERE order_id=$1 FOR UPDATE', [orderId])).rows[0];
  if (!order) throw new Error('Order not found');
  if ([order.status, order.payment_status, order.shipment_status].some((status) => ['canceled', 'cancelled'].includes(status))) {
    throw new Error('Order was already canceled; no second inventory release');
  }
  const native = (await connection.query(`SELECT p.product_id,p.sku FROM order_item oi JOIN product p ON p.product_id=oi.product_id
    JOIN product_inventory i ON i.product_inventory_product_id=p.product_id JOIN shusha_bridge_inventory b ON b.sku=p.sku
    WHERE oi.order_item_order_id=$1 ORDER BY p.product_id FOR UPDATE OF i`, [orderId])).rows;
  await connection.query(`SELECT sku FROM shusha_bridge_inventory WHERE sku=ANY($1::text[]) ORDER BY sku FOR UPDATE`, [native.map((row) => row.sku)]);
  const missing = (await connection.query(`SELECT COUNT(*)::int AS count FROM order_item oi
    JOIN product p ON p.product_id=oi.product_id JOIN shusha_bridge_inventory b ON b.sku=p.sku
    LEFT JOIN shusha_bridge_order_line l ON l.platform='evershop' AND l.order_id=$1::text AND l.line_id=oi.order_item_id::text
    WHERE oi.order_item_order_id=$1::int AND (l.line_id IS NULL OR l.released_qty<>0 OR l.consumed_qty<>oi.qty)`, [String(orderId)])).rows[0];
  if (missing.count) throw new Error('Native cancellation needs its recorded line release basis');
}

/** AFTER native reStockAfterCancel, still inside its original transaction. */
export async function recordNativeCancel(connection, orderId) {
  requireTransaction(connection);
  const lines = (await connection.query(`SELECT * FROM shusha_bridge_order_line WHERE platform='evershop'
    AND order_id=$1 ORDER BY sku,line_id FOR UPDATE`, [String(orderId)])).rows;
  for (const line of lines) {
    const release = integer(line.consumed_qty) - integer(line.released_qty);
    if (!release) continue;
    await ledgerDelta(connection, { platform: 'evershop', orderId, lineId: line.line_id, sku: line.sku,
      delta: release, businessKey: `evershop:${orderId}:${line.line_id}:cancel-release`, reason: line.legacy ? 'legacy-cancel' : 'order-canceled' });
    await connection.query(`UPDATE shusha_bridge_order_line SET released_qty=consumed_qty,updated_at=NOW()
      WHERE platform='evershop' AND order_id=$1 AND line_id=$2`, [String(orderId), line.line_id]);
  }
}

/** Only authoritative normalized snapshots enter here; delivery IDs are not business keys. */
export async function applyShopifySnapshot(connection, order) {
  requireTransaction(connection);
  for (const line of [...order.lines].sort((a, b) => a.sku.localeCompare(b.sku) || a.id.localeCompare(b.id))) {
    const consumed = integer(line.quantity); const released = integer(line.releasedQuantity);
    if (consumed < 0 || released < 0 || released > consumed) throw new Error('Invalid Shopify line release basis');
    const mapped = (await connection.query('SELECT sku FROM shusha_bridge_inventory WHERE sku=$1 FOR UPDATE', [line.sku])).rows[0];
    if (!mapped) throw new Error('Shopify order contains an unmapped capacity SKU');
    await connection.query(`INSERT INTO shusha_bridge_order_line(platform,order_id,line_id,sku,consumed_qty,released_qty,legacy)
      VALUES('shopify',$1,$2,$3,0,0,FALSE) ON CONFLICT(platform,order_id,line_id) DO NOTHING`, [order.id, line.id, line.sku]);
    const previous = (await connection.query(`SELECT * FROM shusha_bridge_order_line WHERE platform='shopify'
      AND order_id=$1 AND line_id=$2 FOR UPDATE`, [order.id, line.id])).rows[0];
    if (previous.sku !== line.sku) throw new Error('Shopify order line SKU changed');
    // Quantities are monotone cumulative facts; old snapshots cannot undo an effect.
    const nextConsumed = Math.max(consumed, integer(previous.consumed_qty));
    const nextReleased = Math.max(released, integer(previous.released_qty));
    const consume = nextConsumed - integer(previous.consumed_qty);
    const release = nextReleased - integer(previous.released_qty);
    if (consume) await ledgerDelta(connection, { platform: 'shopify', orderId: order.id, lineId: line.id, sku: line.sku,
      delta: -consume, businessKey: `shopify:${order.id}:${line.id}:consume:${nextConsumed}`, reason: 'order-line-consumed' });
    if (release) await ledgerDelta(connection, { platform: 'shopify', orderId: order.id, lineId: line.id, sku: line.sku,
      delta: release, businessKey: `shopify:${order.id}:${line.id}:release:${nextReleased}`, reason: 'verified-native-restock' });
    await connection.query(`UPDATE shusha_bridge_order_line SET consumed_qty=$3,released_qty=$4,updated_at=NOW()
      WHERE platform='shopify' AND order_id=$1 AND line_id=$2`, [order.id, line.id, nextConsumed, nextReleased]);
    if (line.releaseAmbiguous) await freezeSku(connection, line.sku, 'shopify-restock-evidence-required');
  }
}
