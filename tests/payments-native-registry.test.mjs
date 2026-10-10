import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import migrateNativeRegistry from '../extensions/bank-transfer/src/migration/Version-1.0.3.js';
import { claimNativeReceipt } from '../extensions/bank-transfer/src/services/globalReceipt.js';
import migrateBridgePayment from '../extensions/shopify-bridge/src/migration/Version-1.0.2.js';
import { createPaymentRepository } from '../extensions/shopify-bridge/src/services/paymentRepository.js';

const connectionString = process.env.SHOPIFY_BRIDGE_TEST_DATABASE_URL || process.env.SHUSHA_BRIDGE_TEST_DATABASE_URL;
const sqlTest = (name, work) => test(name, { skip: !connectionString }, async () => {
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /_test$/.test(url.pathname), 'Only an isolated local synthetic database is permitted');
  const schema = `receipt_native_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
  try {
    await pool.query(`CREATE TABLE "order"(order_id integer PRIMARY KEY, uuid uuid NOT NULL UNIQUE, grand_total numeric(12,2) NOT NULL, payment_status text NOT NULL, shipment_status text NOT NULL);
      CREATE TABLE shusha_payment_receipt(receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,receipt_reference text UNIQUE NOT NULL,order_id integer NOT NULL REFERENCES "order",currency char(3) NOT NULL,amount numeric(12,2) NOT NULL,quote_revision integer NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE synthetic_payment_transaction(reference text PRIMARY KEY);
      INSERT INTO "order" VALUES(1,'10000000-0000-4000-8000-000000000001',12.34,'pending','pending'),(2,'10000000-0000-4000-8000-000000000002',56.78,'pending','pending');`);
    await work(pool);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
async function transaction(pool, work) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); client.INTRANSACTION = true; const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.INTRANSACTION = false; client.release(); }
}
const nativeReceipt = fields => ({ reference: 'SYNTHETIC-NATIVE-RECEIPT', orderUuid: '10000000-0000-4000-8000-000000000001', currency: 'USD', amount: '12.34', quoteRevision: 1, ...fields });
const snapshot = async pool => JSON.stringify((await pool.query('SELECT * FROM "order" ORDER BY order_id')).rows);

test('native registry claim refuses an absent original order transaction before issuing SQL', async () => {
  let calls = 0; await assert.rejects(claimNativeReceipt({ query: async () => { calls++; } }, nativeReceipt()), /original order transaction/); assert.equal(calls, 0);
});

sqlTest('legacy normalized receipt collisions roll back the registry migration and preserve original money and statuses', async pool => {
  await pool.query("INSERT INTO shusha_payment_receipt(receipt_reference,order_id,currency,amount,quote_revision) VALUES(' Synthetic Receipt ',1,'USD',12.34,1),('SYNTHETIC RECEIPT',2,'USD',56.78,1)");
  const beforeOrders = await snapshot(pool), beforeReceipts = (await pool.query('SELECT * FROM shusha_payment_receipt ORDER BY receipt_id')).rows;
  await assert.rejects(transaction(pool, client => migrateNativeRegistry(client)), /identity collision/);
  // The created table and earlier inserted seed must both disappear. Look up
  // only this schema; another test schema must not masquerade as our registry.
  const exists = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=current_schema() AND tablename='shusha_payment_receipt_registry'"); assert.equal(exists.rows[0].n, 0);
  assert.equal(await snapshot(pool), beforeOrders); assert.deepEqual((await pool.query('SELECT * FROM shusha_payment_receipt ORDER BY receipt_id')).rows, beforeReceipts);
});

sqlTest('successful legacy seeding is idempotent and prevents Shopify from reusing that real receipt reference', async pool => {
  await pool.query("INSERT INTO shusha_payment_receipt(receipt_reference,order_id,currency,amount,quote_revision) VALUES(' synthetic-ref-1 ',1,'USD',12.34,3)");
  const before = await snapshot(pool); await transaction(pool, client => migrateNativeRegistry(client)); await transaction(pool, client => migrateNativeRegistry(client)); await migrateBridgePayment(pool);
  const registry = (await pool.query('SELECT * FROM shusha_payment_receipt_registry')).rows; assert.equal(registry.length, 1); assert.equal(registry[0].reference, 'SYNTHETIC-REF-1'); assert.equal(registry[0].order_key, 'evershop:10000000-0000-4000-8000-000000000001'); assert.equal(registry[0].amount, '12.34'); assert.equal(registry[0].quote_revision, 3); assert.equal(await snapshot(pool), before);
  const repository = createPaymentRepository({ pool, shop: 'synthetic-native-test.myshopify.com' });
  await assert.rejects(repository.claimReceipt({ reference: 'SYNTHETIC-REF-1', platform: 'shopify', orderKey: 'synthetic-native-test.myshopify.com:gid://shopify/Order/1', currency: 'USD', amount: '12.34', quoteRevision: 3, createdAt: '2026-01-01T00:00:00Z' }), /already claimed/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM shusha_bridge_payment_receipt')).rows[0].n, 0);
});

sqlTest('a Shopify receipt claim cannot be reassigned to a native order or changed amount', async pool => {
  await transaction(pool, client => migrateNativeRegistry(client)); await migrateBridgePayment(pool);
  const repository = createPaymentRepository({ pool, shop: 'synthetic-native-test.myshopify.com' });
  await repository.claimReceipt({ reference: 'SYNTHETIC-NATIVE-RECEIPT', platform: 'shopify', orderKey: 'synthetic-native-test.myshopify.com:gid://shopify/Order/1', currency: 'USD', amount: '12.34', quoteRevision: 1, createdAt: '2026-01-01T00:00:00Z' });
  const before = await snapshot(pool); await assert.rejects(transaction(pool, client => claimNativeReceipt(client, nativeReceipt())), /another order or amount/);
  assert.equal((await pool.query('SELECT platform FROM shusha_payment_receipt_registry')).rows[0].platform, 'shopify'); assert.equal(await snapshot(pool), before);
});

sqlTest('native claim and payment transaction roll back together after downstream failure', async pool => {
  await transaction(pool, client => migrateNativeRegistry(client));
  const before = await snapshot(pool);
  await assert.rejects(transaction(pool, async client => {
    await claimNativeReceipt(client, nativeReceipt()); await client.query('INSERT INTO synthetic_payment_transaction VALUES($1)', ['SYNTHETIC-NATIVE-RECEIPT']); await client.query("UPDATE \"order\" SET payment_status='paid' WHERE order_id=1"); throw new Error('synthetic downstream native payment failure');
  }), /downstream native payment failure/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM shusha_payment_receipt_registry')).rows[0].n, 0); assert.equal((await pool.query('SELECT count(*)::int AS n FROM synthetic_payment_transaction')).rows[0].n, 0); assert.equal(await snapshot(pool), before);
  await transaction(pool, client => claimNativeReceipt(client, nativeReceipt())); await transaction(pool, client => claimNativeReceipt(client, nativeReceipt())); assert.equal((await pool.query('SELECT count(*)::int AS n FROM shusha_payment_receipt_registry')).rows[0].n, 1);
  for (const field of [{ orderUuid: '10000000-0000-4000-8000-000000000002' }, { amount: '12.35' }, { quoteRevision: 2 }, { currency: 'EUR' }]) await assert.rejects(transaction(pool, client => claimNativeReceipt(client, nativeReceipt(field))), /another order or amount/);
});
