import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import foundationMigration from '../extensions/shopify-bridge/src/migration/Version-1.0.0.js';
import operationsMigration from '../extensions/shopify-bridge/src/migration/Version-1.0.1.js';
import nativeStockMigration from '../packages/evershop/src/modules/checkout/migration/Version-1.0.2.js';
import { integer, openCapacity, beforeNativeOrder, recordNativeOrder, beforeNativeCancel, recordNativeCancel, projectShopifyDelta } from '../extensions/shopify-bridge/src/services/inventory.js';
import { withTransaction, processOutbox, inventoryOutcome, IDEMPOTENCY_RETRY_WINDOW_MS } from '../extensions/shopify-bridge/src/services/outbox.js';
import { ingestShopifyOrder, auditCapacity, normalizeShopifyOrder, hydrateShopifyOrder, reconcileRecentOrders } from '../extensions/shopify-bridge/src/services/orders.js';
import { enqueuePriceChanges, processInbox, openNewMappedCapacity, loadPublishedCollectionSnapshot, followPublishedCollections, runBridgeReconcile } from '../extensions/shopify-bridge/src/services/worker.js';

const fixtureUrl = process.env.SHUSHA_BRIDGE_TEST_DATABASE_URL;
test('a failed transaction rollback discards the connection and preserves the original failure', async () => {
  const original = new Error('Synthetic work failed'); const rollback = new Error('Synthetic rollback failed');
  let discarded;
  const connection = { query: async (sql) => { if (sql === 'ROLLBACK') throw rollback; }, release: (error) => { discarded = error; } };
  await assert.rejects(withTransaction({ connect: async () => connection }, async () => { throw original; }), (error) => error === original);
  assert.equal(discarded, rollback); assert.equal(connection.INTRANSACTION, false);
});
const sqlTest = (name, work) => test(name, { skip: !fixtureUrl }, async () => {
  const url = new URL(fixtureUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /_test$/.test(url.pathname), 'Only a dedicated local synthetic test database is permitted');
  const admin = new Pool({ connectionString: fixtureUrl });
  const schema = `bridge_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: fixtureUrl, options: `-c search_path=${schema},public`, max: 8 });
  try {
    await withTransaction(pool, async (connection) => {
      await connection.query(`CREATE TABLE product(product_id integer PRIMARY KEY,sku text UNIQUE NOT NULL,price numeric NOT NULL DEFAULT 10);
        CREATE TABLE product_inventory(product_inventory_product_id integer PRIMARY KEY REFERENCES product,qty integer NOT NULL,manage_stock boolean NOT NULL DEFAULT TRUE);
        CREATE TABLE "order"(order_id integer PRIMARY KEY,uuid uuid DEFAULT gen_random_uuid(),order_number integer DEFAULT 10000,
          status text DEFAULT 'new',payment_status text DEFAULT 'pending',shipment_status text DEFAULT 'pending',currency text DEFAULT 'USD',
          grand_total numeric DEFAULT 10,shusha_shipping_preference text,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW());
        CREATE TABLE order_item(order_item_id integer PRIMARY KEY,order_item_order_id integer REFERENCES "order",product_id integer REFERENCES product,
          qty integer NOT NULL,product_sku text DEFAULT 'SHUSHA-L1000-BLACK-S',product_name text DEFAULT 'Synthetic dress',final_price numeric DEFAULT 10);`);
      await foundationMigration(connection); await operationsMigration(connection); await nativeStockMigration(connection);
      await connection.query("INSERT INTO product(product_id,sku) VALUES(1,'SHUSHA-L1000-BLACK-S'); INSERT INTO product_inventory VALUES(1,999,TRUE)");
    });
    await work(pool);
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
const sku = 'SHUSHA-L1000-BLACK-S';
const mapping = { inventoryItemId: 'gid://shopify/InventoryItem/1000', locationId: 'gid://shopify/Location/1000' };
const queryRow = async (pool) => (await pool.query('SELECT b.*,i.qty AS native_qty FROM shusha_bridge_inventory b JOIN product_inventory i ON i.product_inventory_product_id=b.product_id')).rows[0];
const open = (pool) => withTransaction(pool, (connection) => openCapacity(connection, { skus: [sku] }));
const cart = (quantity) => ({ getItems: () => [{ getData: (key) => ({ product_sku: sku, qty: quantity })[key] }] });
async function nativeOrder(pool, id, quantity, { fault = false } = {}) {
  return withTransaction(pool, async (connection) => {
    await connection.query('INSERT INTO "order"(order_id) VALUES($1)', [id]);
    await connection.query('INSERT INTO order_item(order_item_id,order_item_order_id,product_id,qty) VALUES($1,$1,1,$2)', [id, quantity]);
    const original = connection.query;
    if (fault) {
      connection.query = (sql, args, callback) => {
        if (sql.includes('INSERT INTO shusha_bridge_outbox')) throw new Error('synthetic outbox crash');
        return original.call(connection, sql, args, callback);
      };
    }
    try { await recordNativeOrder(connection, id); }
    finally { connection.query = original; }
  });
}
async function nativeCancel(pool, id) {
  return withTransaction(pool, async (connection) => {
    await beforeNativeCancel(connection, id);
    await connection.query('UPDATE "order" SET status=\'canceled\',payment_status=\'canceled\' WHERE order_id=$1', [id]);
    await connection.query(`UPDATE product_inventory SET qty=qty+(SELECT SUM(qty) FROM order_item WHERE order_item_order_id=$1) WHERE product_inventory_product_id=1`, [id]);
    await recordNativeCancel(connection, id);
  });
}
const shopOrder = (quantity, extra = {}) => ({ id: 1000, name: '#S1000', currency: 'USD', current_total_price: '19.99',
  financial_status: 'pending', updated_at: '2026-10-10T01:00:00Z', line_items: [{ id: 2000, sku, quantity }], ...extra });
function provider(quantity = 0) {
  const cache = new Map(); const mutations = [];
  return { quantity, cache, mutations, loseNextResponse: false, staleNext: false,
    async request(query, variables) {
      if (query.startsWith('query')) return { inventoryItem: { inventoryLevel: { quantities: [{ name: 'available', quantity: this.quantity }] } } };
      mutations.push(structuredClone(variables));
      const key = variables.idempotencyKey;
      if (cache.has(key)) return structuredClone(cache.get(key));
      const change = variables.input.changes[0];
      if (this.staleNext || change.changeFromQuantity !== this.quantity) {
        this.staleNext = false;
        return { inventoryAdjustQuantities: { userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE' }], inventoryAdjustmentGroup: null } };
      }
      this.quantity += change.delta;
      const result = { inventoryAdjustQuantities: { userErrors: [], inventoryAdjustmentGroup: { createdAt: '2026-10-10T01:00:00Z', changes: [{ name: 'available', delta: change.delta }] } } };
      cache.set(key, result);
      if (this.loseNextResponse) { this.loseNextResponse = false; throw new Error('synthetic response lost after provider commit'); }
      return structuredClone(result);
    }
  };
}
const drain = (pool, client) => processOutbox(pool, { client, writesEnabled: true, resolveInventory: async () => mapping });
const ready = (pool) => pool.query("UPDATE shusha_bridge_outbox SET available_at=NOW(),lease_until=NULL WHERE state<>'applied'");

test('negative request capacity and cancellation repay Shopify debt first', () => {
  assert.deepEqual(projectShopifyDelta(0, 3, 2), { quantity: 0, debt: 1, delta: 0 });
  assert.deepEqual(projectShopifyDelta(0, 3, 5), { quantity: 2, debt: 0, delta: 2 });
  assert.deepEqual(projectShopifyDelta(1, 0, -4), { quantity: 0, debt: 3, delta: -1 });
  for (const value of [null, undefined, '', '1.5', false, NaN]) assert.throws(() => integer(value));
});

test('only an explicit CAS-stale response proves non-write', () => {
  assert.equal(inventoryOutcome({ inventoryAdjustQuantities: { userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE' }] } }), 'nonwrite');
  assert.equal(inventoryOutcome({ inventoryAdjustQuantities: { userErrors: [{ code: 'SERVICE_UNAVAILABLE' }] } }), 'unknown');
  assert.equal(inventoryOutcome({ inventoryAdjustQuantities: { userErrors: [{ code: 'IDEMPOTENCY_CONCURRENT_REQUEST' }] } }), 'unknown');
});

test('canceled and refunded money is not itself inventory-release proof', () => {
  const ambiguous = normalizeShopifyOrder(shopOrder(2, { cancelled_at: '2026-10-10T02:00:00Z' }));
  assert.equal(ambiguous.lines[0].releasedQuantity, 0); assert.equal(ambiguous.lines[0].releaseAmbiguous, true);
  const noRestock = normalizeShopifyOrder(shopOrder(2, { refunds: [{ id: 1, refund_line_items: [{ id: 1, line_item_id: 2000, quantity: 2, restock_type: 'no_restock' }] }] }));
  assert.equal(noRestock.lines[0].releasedQuantity, 0);
});

test('authoritative order hydration rejects a changing multi-page snapshot', async () => {
  let calls = 0;
  await assert.rejects(hydrateShopifyOrder({ async request() {
    calls += 1; return { order: { id: 'gid://shopify/Order/1000', updatedAt: String(calls), refunds: [],
      lineItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` } } } };
  } }, 1000), /changed during hydration/);
});

test('nullable native refund-line IDs preserve each verified line release', () => {
  const order = normalizeShopifyOrder(shopOrder(2, {
    line_items: [{ id: 2000, sku, quantity: 2 }, { id: 2001, sku, quantity: 3 }],
    refunds: [{ id: 'gid://shopify/Refund/1', refundLineItems: { nodes: [
      { id: null, lineItem: { id: 'gid://shopify/LineItem/2000' }, quantity: 2, restockType: 'CANCEL', restocked: true },
      { id: null, lineItem: { id: 'gid://shopify/LineItem/2001' }, quantity: 3, restockType: 'RETURN', restocked: true }
    ] } }]
  }));
  assert.deepEqual(order.lines.map((line) => line.releasedQuantity), [2, 3]);
});

test('v2.2.1 stock trigger and hooks remain inside the native order transaction', async () => {
  const creator = await readFile(new URL('../packages/evershop/src/modules/checkout/services/orderCreator.ts', import.meta.url), 'utf8');
  const cancel = await readFile(new URL('../packages/evershop/src/modules/oms/services/cancelOrder.ts', import.meta.url), 'utf8');
  assert.ok(creator.indexOf('hookable(saveOrderItems') < creator.indexOf('await commit(connection)'));
  assert.ok(cancel.indexOf('hookable(reStockAfterCancel') < cancel.indexOf('await commit(connection)'));
  assert.match(cancel, /hookBeforeUpdatePaymentStatusToCancel/); assert.match(cancel, /hookAfterReStockAfterCancel/);
});

sqlTest('opening uses actual remaining stock and preserves old cancellation basis', async (pool) => {
  await pool.query('INSERT INTO "order"(order_id) VALUES(1); INSERT INTO order_item VALUES(1,1,1,4,\'SHUSHA-L1000-BLACK-S\',\'Synthetic dress\',10)');
  await open(pool); assert.equal((await queryRow(pool)).balance, '995');
  assert.equal((await pool.query('SELECT legacy,consumed_qty FROM shusha_bridge_order_line')).rows[0].legacy, true);
  await open(pool); assert.equal((await queryRow(pool)).balance, '995');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM shusha_bridge_outbox')).rows[0].count, 1);
  await nativeCancel(pool, 1); assert.equal((await queryRow(pool)).balance, '999');
  await assert.rejects(nativeCancel(pool, 1), /already canceled/); assert.equal((await queryRow(pool)).balance, '999');
});

sqlTest('an outbox crash rolls back native order stock, ledger and business line', async (pool) => {
  await open(pool); await assert.rejects(nativeOrder(pool, 1, 3, { fault: true }), /outbox crash/);
  assert.equal((await queryRow(pool)).native_qty, 999); assert.equal((await queryRow(pool)).balance, '999');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM "order"')).rows[0].count, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM shusha_bridge_ledger')).rows[0].count, 0);
});

sqlTest('native checkout guards unopened, frozen and centrally consumed mapped capacity before its trigger', async (pool) => {
  await pool.query("INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('product','synthetic-style',$1)",
    [JSON.stringify({ variants: [{ sku }] })]);
  await assert.rejects(withTransaction(pool, (tx) => beforeNativeOrder(tx, cart(1))), /not been opened/);
  await open(pool);
  await pool.query('UPDATE shusha_bridge_inventory SET frozen=TRUE');
  await assert.rejects(withTransaction(pool, (tx) => beforeNativeOrder(tx, cart(1))), /temporarily paused/);
  await pool.query('UPDATE shusha_bridge_inventory SET frozen=FALSE,balance=0');
  await assert.rejects(withTransaction(pool, (tx) => beforeNativeOrder(tx, cart(1))), /no longer available/);
  assert.equal((await queryRow(pool)).native_qty, 999);
});

sqlTest('concurrent native checkout guards serialize on native stock and central capacity', async (pool) => {
  await pool.query('UPDATE product_inventory SET qty=1');
  await pool.query("INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('product','synthetic-style',$1)",
    [JSON.stringify({ variants: [{ sku }] })]);
  await open(pool);
  const checkout = (id) => withTransaction(pool, async (tx) => {
    await beforeNativeOrder(tx, cart(1));
    await tx.query('INSERT INTO "order"(order_id) VALUES($1)', [id]);
    await tx.query('INSERT INTO order_item(order_item_id,order_item_order_id,product_id,qty) VALUES($1,$1,1,1)', [id]);
    await recordNativeOrder(tx, id);
  });
  const results = await Promise.allSettled([checkout(1), checkout(2)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await queryRow(pool)).balance, '0'); assert.equal((await queryRow(pool)).native_qty, 0);
});

sqlTest('concurrent duplicate native cancellation releases exactly once', async (pool) => {
  await open(pool); await nativeOrder(pool, 1, 3);
  const attempts = await Promise.allSettled([nativeCancel(pool, 1), nativeCancel(pool, 1)]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal((await queryRow(pool)).native_qty, 999); assert.equal((await queryRow(pool)).balance, '999');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM shusha_bridge_ledger WHERE reason='order-canceled'")).rows[0].count, 1);
});

sqlTest('missing legacy release basis prevents a native restock', async (pool) => {
  await open(pool);
  await pool.query('INSERT INTO "order"(order_id) VALUES(1); INSERT INTO order_item VALUES(1,1,1,2,\'SHUSHA-L1000-BLACK-S\',\'Synthetic dress\',10)');
  await assert.rejects(nativeCancel(pool, 1), /release basis/); assert.equal((await queryRow(pool)).native_qty, 997);
});

sqlTest('duplicate and out-of-order Shopify snapshots do not duplicate effects', async (pool) => {
  await open(pool);
  const canceled = shopOrder(2, { cancelled_at: '2026-10-10T02:00:00Z', updated_at: '2026-10-10T02:00:00Z',
    refunds: [{ id: 1, refund_line_items: [{ id: 1, line_item_id: 2000, quantity: 2, restock_type: 'cancel' }] }] });
  await ingestShopifyOrder(pool, canceled); await ingestShopifyOrder(pool, canceled);
  assert.equal((await ingestShopifyOrder(pool, shopOrder(2))).stale, true);
  assert.equal((await queryRow(pool)).balance, '999');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM shusha_bridge_ledger WHERE platform='shopify'")).rows[0].count, 2);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM "order"')).rows[0].count, 0);
});

sqlTest('reconciliation retains completed merchant restock proof without a refund line', async (pool) => {
  await open(pool); await ingestShopifyOrder(pool, shopOrder(2));
  await pool.query("INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('operation','order-restock:gid://shopify/Order/1000',$1)",
    [JSON.stringify({ status: 'complete', restockEvidence: { 'gid://shopify/LineItem/2000': 2 } })]);
  const canceled = shopOrder(2, { updated_at: '2026-10-10T02:00:00Z', cancelled_at: '2026-10-10T02:00:00Z',
    lineItems: { nodes: [{ id: 2000, sku, quantity: 2 }], pageInfo: { hasNextPage: false } }, refunds: [] });
  const result = await reconcileRecentOrders(pool, { client: { async request(query) {
    return query.includes('BridgeRecentOrders') ? { orders: { nodes: [{ id: 1000 }], pageInfo: { hasNextPage: false } } } : { order: canceled };
  } } });
  assert.equal(result.complete, true); assert.equal((await queryRow(pool)).balance, '999');
  assert.equal((await queryRow(pool)).frozen, false);
  assert.equal((await pool.query("SELECT released_qty FROM shusha_bridge_order_line WHERE platform='shopify'")).rows[0].released_qty, '2');
});

sqlTest('cross-store oversale retains debt and cancellation cannot create capacity', async (pool) => {
  await pool.query('UPDATE product_inventory SET qty=2'); await open(pool);
  const client = provider(); await drain(pool, client); assert.equal(client.quantity, 2);
  await nativeOrder(pool, 1, 2); client.quantity -= 2; await ingestShopifyOrder(pool, shopOrder(2));
  await drain(pool, client);
  let row = await queryRow(pool); assert.equal(row.balance, '-2'); assert.equal(row.native_qty, -2); assert.equal(row.shopify_debt, '2'); assert.equal(client.quantity, 0);
  await nativeCancel(pool, 1); await drain(pool, client);
  row = await queryRow(pool); assert.equal(row.balance, '0'); assert.equal(row.native_qty, 0); assert.equal(row.shopify_debt, '0'); assert.equal(client.quantity, 0);
  client.quantity += 2;
  await ingestShopifyOrder(pool, shopOrder(2, { updated_at: '2026-10-10T03:00:00Z', cancelled_at: '2026-10-10T03:00:00Z' }),
    { restockEvidence: { 'gid://shopify/LineItem/2000': 2 } });
  await drain(pool, client); row = await queryRow(pool);
  assert.equal(row.balance, '2'); assert.equal(row.native_qty, 2); assert.equal(client.quantity, 2);
});

sqlTest('response loss replays the original persisted request and provider key', async (pool) => {
  await pool.query('UPDATE product_inventory SET qty=4'); await open(pool); const client = provider();
  client.loseNextResponse = true; await drain(pool, client); assert.equal(client.quantity, 4);
  const unknown = (await pool.query('SELECT state,idempotency_key,request_json FROM shusha_bridge_outbox')).rows[0];
  assert.equal(unknown.state, 'unknown'); await ready(pool); await drain(pool, client);
  assert.equal(client.quantity, 4); assert.equal(client.mutations.length, 2);
  assert.deepEqual(client.mutations[0], client.mutations[1]); assert.equal(client.mutations[1].idempotencyKey, unknown.idempotency_key);
});

sqlTest('CAS-confirmed nonwrite alone permits a new provider attempt', async (pool) => {
  await pool.query('UPDATE product_inventory SET qty=4'); await open(pool); const client = provider();
  client.staleNext = true; await drain(pool, client);
  assert.equal((await pool.query('SELECT idempotency_key FROM shusha_bridge_outbox')).rows[0].idempotency_key, null);
  await ready(pool); await drain(pool, client);
  assert.notEqual(client.mutations[0].idempotencyKey, client.mutations[1].idempotencyKey); assert.equal(client.quantity, 4);
});

sqlTest('an unresolved provider write freezes before the idempotency window expires', async (pool) => {
  await open(pool); const client = provider(); client.loseNextResponse = true; await drain(pool, client);
  await pool.query('UPDATE shusha_bridge_outbox SET request_started_at=$1,available_at=NOW(),lease_until=NULL', [new Date(Date.now() - IDEMPOTENCY_RETRY_WINDOW_MS - 1)]);
  const calls = client.mutations.length; await drain(pool, client); assert.equal(client.mutations.length, calls);
  assert.equal((await queryRow(pool)).frozen, true);
  assert.equal((await pool.query('SELECT state FROM shusha_bridge_outbox')).rows[0].state, 'frozen');
});

sqlTest('opening refuses an existing unexplained Shopify native quantity', async (pool) => {
  await open(pool); const client = provider(20); await drain(pool, client);
  assert.equal(client.quantity, 20); assert.equal(client.mutations.length, 0); assert.equal((await queryRow(pool)).frozen, true);
});

sqlTest('reconciliation explains unapplied deltas without resetting stock', async (pool) => {
  await open(pool); await ingestShopifyOrder(pool, shopOrder(2));
  assert.deepEqual(await auditCapacity(pool), { checked: 1, newlyFrozen: 0, pendingReview: 0, reset: false });
  assert.equal((await queryRow(pool)).native_qty, 999); assert.equal((await queryRow(pool)).balance, '997');
});

sqlTest('a Shopify native cancellation repays debt before its restock can remain sellable', async (pool) => {
  await pool.query('UPDATE product_inventory SET qty=2'); await open(pool); const client = provider(); await drain(pool, client);
  await nativeOrder(pool, 1, 2); client.quantity -= 2; await ingestShopifyOrder(pool, shopOrder(2)); await drain(pool, client);
  assert.equal((await queryRow(pool)).shopify_debt, '2');
  client.quantity += 2;
  await ingestShopifyOrder(pool, shopOrder(2, { updated_at: '2026-10-10T03:00:00Z', cancelled_at: '2026-10-10T03:00:00Z' }),
    { restockEvidence: { 'gid://shopify/LineItem/2000': 2 } });
  await drain(pool, client);
  const row = await queryRow(pool); assert.equal(row.balance, '0'); assert.equal(row.native_qty, 0);
  assert.equal(row.shopify_debt, '0'); assert.equal(client.quantity, 0);
});

sqlTest('a crash after provider success keeps the persisted request and rolls back the debt acknowledgement', async (pool) => {
  await pool.query('UPDATE product_inventory SET qty=-3'); await open(pool); const client = provider(); let crash = true;
  const faultPool = { query: pool.query.bind(pool), async connect() {
    const connection = await pool.connect(); const originalQuery = connection.query; const originalRelease = connection.release;
    connection.query = function(sql, ...args) {
      if (crash && sql.includes("SET state='applied'")) { crash = false; throw new Error('synthetic acknowledgement crash'); }
      return originalQuery.call(this, sql, ...args);
    };
    connection.release = function(...args) { this.query = originalQuery; this.release = originalRelease; return originalRelease.apply(this, args); };
    return connection;
  } };
  await assert.rejects(drain(faultPool, client), /acknowledgement crash/);
  assert.equal((await queryRow(pool)).shopify_debt, '0');
  await ready(pool); await drain(pool, client);
  assert.equal((await queryRow(pool)).shopify_debt, '3'); assert.equal(client.quantity, 0);
  assert.deepEqual(client.mutations[0], client.mutations[1]);
});

sqlTest('ambiguous canceled native orders pause inventory without inventing a release', async (pool) => {
  await open(pool);
  await ingestShopifyOrder(pool, shopOrder(2, { cancelled_at: '2026-10-10T03:00:00Z' }));
  const row = await queryRow(pool); assert.equal(row.balance, '997'); assert.equal(row.frozen, true);
  assert.equal(row.freeze_reason, 'shopify-restock-evidence-required');
});

sqlTest('unknown provider response blocks later same-SKU intents', async (pool) => {
  await open(pool); const client = provider(); client.loseNextResponse = true; await drain(pool, client);
  await nativeOrder(pool, 1, 2); const calls = client.mutations.length; await drain(pool, client);
  assert.equal(client.mutations.length, calls);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM shusha_bridge_outbox WHERE state='applied'")).rows[0].count, 0);
});

sqlTest('an unexplained remote difference needs two stable observations before freezing', async (pool) => {
  await open(pool); const client = provider(); await drain(pool, client);
  const options = { resolveInventory: async () => mapping, readShopifyQuantity: async () => 900, now: () => 1000 };
  let result = await auditCapacity(pool, options); assert.equal(result.pendingReview, 1); assert.equal((await queryRow(pool)).frozen, false);
  result = await auditCapacity(pool, { ...options, now: () => 1000 + 15 * 60000 });
  assert.equal(result.newlyFrozen, 1); assert.equal((await queryRow(pool)).native_qty, 999); assert.equal((await queryRow(pool)).balance, '999');
});

test('native theme courier attributes are shown in the separate Shopify adapter', () => {
  assert.equal(normalizeShopifyOrder(shopOrder(1, { note_attributes: [{ name: 'Preferred courier', value: 'DHL' }] })).preferredCourier, 'DHL');
});

sqlTest('price following deduplicates stable prices while allowing A to B to A', async (pool) => {
  await pool.query(`INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('product','synthetic-source',$1)`,
    [JSON.stringify({ productGid: 'gid://shopify/Product/1000', variants: [{ sku, variantGid: 'gid://shopify/ProductVariant/1000', inventoryItemGid: mapping.inventoryItemId }] })]);
  assert.equal((await enqueuePriceChanges(pool)).queued, 1); assert.equal((await enqueuePriceChanges(pool)).queued, 0);
  await pool.query('UPDATE product SET price=20'); assert.equal((await enqueuePriceChanges(pool)).queued, 1);
  await pool.query('UPDATE product SET price=10'); assert.equal((await enqueuePriceChanges(pool)).queued, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM shusha_bridge_outbox WHERE kind='catalog.prices'")).rows[0].count, 3);
  assert.equal((await pool.query('SELECT qty FROM product_inventory')).rows[0].qty, 999);
});

sqlTest('duplicate inbox deliveries hydrate native facts and reuse order-line business keys', async (pool) => {
  await open(pool);
  await pool.query(`INSERT INTO shusha_bridge_inbox(delivery_id,shop,topic,payload) VALUES
    ('synthetic-1','synthetic.myshopify.com','orders/create','{"id":1000}'),
    ('synthetic-2','synthetic.myshopify.com','orders/create','{"id":1000}')`);
  const client = { async request() { return { order: { id: 'gid://shopify/Order/1000', name: '#S1000', currencyCode: 'USD',
    currentTotalPriceSet: { shopMoney: { amount: '19.99', currencyCode: 'USD' } }, updatedAt: '2026-10-10T01:00:00Z',
    refunds: [], lineItems: { nodes: [{ id: 'gid://shopify/LineItem/2000', sku, quantity: 2, currentQuantity: 2 }], pageInfo: { hasNextPage: false } } } }; } };
  const result = await processInbox(pool, { client }); assert.equal(result.processed, 2); assert.equal(result.failed, 0);
  assert.equal((await queryRow(pool)).balance, '997');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM shusha_bridge_ledger WHERE platform='shopify'")).rows[0].count, 1);
});

sqlTest('uninstallation revokes tokens even when order processing is disabled', async (pool) => {
  await pool.query(`INSERT INTO shusha_bridge_inbox(delivery_id,shop,topic,payload) VALUES('synthetic-uninstall','synthetic.myshopify.com','app/uninstalled','{"id":1,"name":"Synthetic store","myshopify_domain":"synthetic.myshopify.com"}')`);
  let revoked = 0;
  const result = await processInbox(pool, { expectedShop: 'synthetic.myshopify.com', client: { async request() { throw new Error('Unexpected native query'); } }, tokens: { async revoke() { revoked += 1; } }, ordersEnabled: false });
  assert.equal(revoked, 1); assert.equal(result.uninstalled, true); assert.equal(result.processed, 1);
});

sqlTest('a signed order body or mismatched Shop relabeled as uninstall never revokes tokens', async (pool) => {
  await pool.query(`INSERT INTO shusha_bridge_inbox(delivery_id,shop,topic,payload) VALUES
    ('synthetic-wrong-shape','synthetic.myshopify.com','app/uninstalled','{"id":1,"name":"Synthetic order","line_items":[]}'),
    ('synthetic-wrong-shop','synthetic.myshopify.com','app/uninstalled','{"id":1,"name":"Synthetic store","myshopify_domain":"other.myshopify.com"}')`);
  let revoked = 0;
  const result = await processInbox(pool, { expectedShop: 'synthetic.myshopify.com', client: { request: async () => ({}) }, tokens: { revoke: async () => { revoked += 1; } }, ordersEnabled: false });
  assert.equal(revoked, 0); assert.equal(result.failed, 2); assert.equal(result.uninstalled, false);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM shusha_bridge_inbox WHERE state='pending'")).rows[0].count, 2);
});

sqlTest('a null-domain uninstall requires its persisted verified installation Shop ID', async (pool) => {
  await pool.query(`INSERT INTO shusha_bridge_inbox(delivery_id,shop,topic,payload) VALUES
    ('synthetic-null-domain','synthetic.myshopify.com','app/uninstalled','{"id":1,"name":"Synthetic store","myshopify_domain":null}')`);
  let revoked = 0;
  const options = { expectedShop: 'synthetic.myshopify.com', client: { request: async () => ({}) }, tokens: { revoke: async () => { revoked += 1; } }, ordersEnabled: false };
  assert.equal((await processInbox(pool, options)).failed, 1); assert.equal(revoked, 0);
  await pool.query("INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('operation','installation:synthetic.myshopify.com',$1)",
    [JSON.stringify({ kind: 'installation', status: 'complete', shop: 'synthetic.myshopify.com', shopId: '1' })]);
  assert.equal((await processInbox(pool, options)).uninstalled, true); assert.equal(revoked, 1);
});

test('all native bridge workers destroy their session when advisory unlock fails', async () => {
  for (const kind of ['outbox','inbox','reconcile']) {
    const failure = new Error(`Synthetic ${kind} unlock failure`); let released; let connections = 0;
    const owner = { async query(query) { if (query.includes('pg_advisory_unlock')) throw failure; return { rows: [{ locked: true }] }; }, release(error) { released = error; } };
    const pool = { async connect() { connections += 1; return connections === 1 ? owner : { query: async () => ({ rows: [] }), release() {} }; }, query: async () => ({ rows: [] }) };
    const run = kind === 'outbox' ? () => processOutbox(pool, { writesEnabled: true }) : kind === 'inbox' ? () => processInbox(pool, { client: { request: async () => ({}) } }) :
      () => runBridgeReconcile({ pool, config: { enabled: true, writesEnabled: true, scopes: [] }, client: { request: async () => ({ orders: { nodes: [], pageInfo: { hasNextPage: false } } }) } }, { SHOPIFY_SHARED_CAPACITY_ENABLED: 'true' });
    await assert.rejects(run(), (error) => error === failure); assert.equal(released, failure, `${kind} must discard the possibly locked connection`);
  }
});

sqlTest('a canceled webhook waits for a trusted pending original restock job without freezing or retry exhaustion', async (pool) => {
  await open(pool); await ingestShopifyOrder(pool, shopOrder(2));
  const id = 'gid://shopify/Order/1000';
  await pool.query("INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('operation',$1,$2)", [`order-restock:${id}`,
    JSON.stringify({ kind: 'order-cancel', orderId: id, shop: 'synthetic.myshopify.com', status: 'pending', merchantConfirmed: true,
      operationKey: 'synthetic-cancel-1000', inputHash: 'a'.repeat(64), input: { orderId: id, restock: true, notifyCustomer: false, refundMethod: { originalPaymentMethodsRefund: false } } })]);
  await pool.query("INSERT INTO shusha_bridge_inbox(delivery_id,shop,topic,payload) VALUES('synthetic-pending-cancel','synthetic.myshopify.com','orders/cancelled','{\"id\":1000}')");
  const canceled = shopOrder(2, { updated_at: '2026-10-10T02:00:00Z', cancelled_at: '2026-10-10T02:00:00Z', refunds: [],
    lineItems: { nodes: [{ id: 2000, sku, quantity: 2 }], pageInfo: { hasNextPage: false } } });
  const result = await processInbox(pool, { client: { request: async () => ({ order: canceled }) } });
  assert.equal(result.deferred, 1); assert.equal(result.failed, 0); assert.equal((await queryRow(pool)).frozen, false);
  assert.equal((await queryRow(pool)).balance, '997');
  const delivery = (await pool.query('SELECT attempts,state FROM shusha_bridge_inbox')).rows[0];
  assert.equal(delivery.attempts, 0); assert.equal(delivery.state, 'pending');
});

sqlTest('stock writer kind filtering leaves capacity untouched before phase 3', async (pool) => {
  await open(pool); await ingestShopifyOrder(pool, shopOrder(2)); const client = provider();
  const result = await processOutbox(pool, { client, writesEnabled: true, allowedKinds: ['catalog.prices'] });
  assert.equal(result.processed, 0); assert.equal(client.mutations.length, 0); assert.equal((await queryRow(pool)).native_qty, 999);
});

test('new style opening requires the explicit activation and capacity flags', async () => {
  assert.deepEqual(await openNewMappedCapacity({ config: { writesEnabled: true } }, {}), { opened: 0 });
});

sqlTest('collection following uses native category UUIDs and excludes drafts and READY materials', async (pool) => {
  await pool.query(`ALTER TABLE product ADD COLUMN uuid uuid DEFAULT gen_random_uuid(),ADD COLUMN status boolean DEFAULT TRUE,ADD COLUMN visibility boolean DEFAULT TRUE;
    CREATE TABLE category(category_id integer PRIMARY KEY,uuid uuid DEFAULT gen_random_uuid(),status boolean DEFAULT TRUE);
    CREATE TABLE category_description(category_description_category_id integer REFERENCES category,url_key text,name text,description text);
    CREATE TABLE product_description(product_description_product_id integer REFERENCES product,url_key text);
    CREATE TABLE product_category(product_id integer REFERENCES product,category_id integer REFERENCES category);
    CREATE TABLE shusha_material_publication(source_id text,anchor_sku text,status text,plan jsonb,created_at timestamptz);
    INSERT INTO category(category_id) VALUES(1),(2),(3);
    INSERT INTO category_description VALUES(1,'dresses','Dresses','<p>Current dresses</p>'),(2,'pants','Pants',''),(3,'tops','Tops','');
    INSERT INTO product(product_id,sku) VALUES(2,'SHUSHA-L1000'),(3,'SHUSHA-L1001'),(4,'SHUSHA-L1002');
    INSERT INTO product_description VALUES(2,'l1000'),(3,'l1001'),(4,'l1002');
    INSERT INTO product_category VALUES(2,1),(3,1),(4,1);
    INSERT INTO shusha_material_publication VALUES
      ('L1000','SHUSHA-L1000','complete','{"category":"dresses","review":{"ready":true}}','2026-10-09'),
      ('L1001','SHUSHA-L1001','complete','{"category":"dresses","review":{"ready":true}}','2026-10-10'),
      ('L1002','SHUSHA-L1002','READY','{"category":"dresses","review":{"ready":true}}','2026-10-11')`);
  const products = (await pool.query('SELECT product_id,uuid FROM product WHERE product_id>1 ORDER BY product_id')).rows;
  for (const product of products) await pool.query("INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('product',$1,$2)",
    [product.uuid, JSON.stringify({ productGid: `gid://shopify/Product/${product.product_id}` })]);
  const snapshot = await loadPublishedCollectionSnapshot({ pool, client: { async request(_document, variables) {
    assert.deepEqual(variables.ids, ['gid://shopify/Product/2','gid://shopify/Product/3']);
    return { nodes: products.slice(0, 2).map((product) => ({ id: `gid://shopify/Product/${product.product_id}`,
      status: product.product_id === 2 ? 'ACTIVE' : 'DRAFT', publishedOnPublication: product.product_id === 2,
      metafield: { value: product.uuid } })) };
  } } }, { SHOPIFY_PUBLICATION_ID: 'gid://shopify/Publication/1' });
  const categories = (await pool.query('SELECT uuid FROM category ORDER BY category_id')).rows;
  assert.equal(snapshot.collections[0].sourceUuid, categories[0].uuid);
  assert.deepEqual(snapshot.collections[0].productUuids, [products[0].uuid]);
  assert.equal(snapshot.products.length, 1); assert.equal(snapshot.products[0].handle, 'l1000');
  assert.deepEqual(snapshot.pages, []); assert.deepEqual(snapshot.menus, []);
});

test('collection follower retains pending recovery and skips unchanged completed membership', async () => {
  const records = new Map(); let calls = 0; let fail = true; let held = false;
  const runtime = { config: { enabled: true, writesEnabled: true, shop: 'synthetic.myshopify.com' }, client: {},
    repositories: { mappings: {
      withLock: async (_key, work) => { held = true; try { return await work(); } finally { held = false; } },
      getOperation: async (key) => records.get(key), saveOperation: async (key, value) => records.set(key, structuredClone(value)),
      get: async () => null, put: async () => {}
    } } };
  const env = { SHOPIFY_CONTENT_SYNC_ENABLED: 'true', SHOPIFY_CATALOG_PUBLICATION_ENABLED: 'true',
    SHOPIFY_SHARED_CAPACITY_ENABLED: 'true', SHOPIFY_PAYMENT_OPERATIONS_ENABLED: 'true' };
  const snapshot = { products: [], collections: [{ sourceUuid: 'native-category', productUuids: [] }], pages: [], menus: [], redirects: [] };
  const options = { snapshotProvider: async () => snapshot, synchronizerFactory: ({ stateStore }) => ({ async sync(_snapshot, flags) {
    assert.equal(held, true); assert.equal(flags.dryRun, false); assert.equal(flags.publishPages, false);
    assert.equal(records.get('collection-follower').status, 'pending');
    await stateStore.withLock(async () => { calls += 1; });
    if (fail) throw new Error('Synthetic interrupted collection job');
    return { pages: 0, menus: 0, collections: 1 };
  } }) };
  await assert.rejects(followPublishedCollections(runtime, env, options), /interrupted collection/);
  assert.equal(records.get('collection-follower').status, 'pending'); fail = false;
  assert.equal((await followPublishedCollections(runtime, env, options)).status, 'completed');
  assert.equal((await followPublishedCollections(runtime, env, options)).status, 'unchanged');
  assert.equal(calls, 2);
  assert.equal((await followPublishedCollections(runtime, { ...env, SHOPIFY_CONTENT_SYNC_ENABLED: 'false' }, options)).status, 'disabled');
  assert.equal(calls, 2);
});
