import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import migration from '../src/migration/Version-1.0.2.js';
import foundationMigration from '../src/migration/Version-1.0.0.js';
import { createPaymentRepository } from '../src/services/paymentRepository.js';

const connectionString = process.env.SHOPIFY_BRIDGE_TEST_DATABASE_URL;
const shop = 'synthetic-payments.myshopify.com';
const id = number => `gid://shopify/Order/${number}`;
const key = number => `${shop}:${id(number)}`;
const receipt = (number, fields = {}) => ({ reference: 'SYNTHETIC-RECEIPT-001', platform: 'shopify', orderKey: key(number), currency: 'USD', amount: '12.34', quoteRevision: 1, createdAt: '2026-01-01T00:00:00.000Z', ...fields });
const quote = (number, fields = {}) => ({ shop, orderId: id(number), revision: 1, paymentVersion: 2, status: 'confirmed', currency: 'USD', amount: '12.34', privateSynthetic: true, ...fields });
const operation = (number, fields = {}) => ({ key: 'synthetic-operation-001', kind: 'quote', shop, orderId: id(number), inputHash: 'a'.repeat(64), status: 'prepared', ...fields });
const registrySql = `CREATE TABLE shusha_payment_receipt_registry(reference text PRIMARY KEY, platform text NOT NULL, order_key text NOT NULL,
  currency char(3) NOT NULL, amount numeric(12,2) NOT NULL, quote_revision integer NOT NULL,
  created_at timestamptz NOT NULL, record jsonb NOT NULL DEFAULT '{}')`;

async function sqlFixture(work) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Payment SQL tests require an isolated local test database');
  const schema = `bridge_payment_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, max: 12, options: `-c search_path=${schema},public` });
  try {
    await foundationMigration(pool);
    await pool.query(registrySql);
    await migration(pool);
    await work(pool, createPaymentRepository({ pool, shop }));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
const sqlTest = (name, work) => test(name, { skip: !connectionString }, () => sqlFixture(work));

test('payment migration requires native receipt seeding before additive private tables', async () => {
  const statements = [];
  await assert.rejects(migration({ query: async sql => { statements.push(sql); return { rows: [] }; } }), /Native global receipt migration/);
  assert.equal(statements.length, 1);
  statements.length = 0;
  await migration({ query: async sql => { statements.push(sql); return { rows: [{ registry: 'shusha_payment_receipt_registry' }] }; } });
  assert.equal(statements.length, 6);
  assert.ok(statements.slice(1).every(sql => /^CREATE (TABLE|INDEX) IF NOT EXISTS shusha_bridge_payment_/.test(sql)));
  assert.ok(statements.some(sql => /reference text PRIMARY KEY REFERENCES shusha_payment_receipt_registry\(reference\)/.test(sql)));
  assert.equal(statements.some(sql => /\b(UPDATE|DELETE|DROP|INSERT)\b/.test(sql)), false);
});

test('failed session lock acquisition discards its pool connection before reuse', async () => {
  const failure = new Error('synthetic disconnected session'); let released;
  const repository = createPaymentRepository({ shop, pool: { query() {}, async connect() { return {
    async query() { throw failure; }, release(error) { released = error; }
  }; } } });
  await assert.rejects(repository.withOrderLock(id(1), async () => assert.fail('Callback must not run')), /session lock release failed/);
  assert.equal(released, failure);
});

sqlTest('global reference races across distinct orders produce exactly one durable claim and ledger', async (pool, repository) => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => repository.withOrderLock(id(index + 1), () => repository.claimReceipt(receipt(index + 1)))));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 7);
  assert.ok(results.filter(row => row.status === 'rejected').every(row => /already claimed/.test(row.reason.message)));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM shusha_payment_receipt_registry')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM shusha_bridge_payment_receipt')).rows[0].n, 1);
  const winner = await repository.getReceipt('synthetic-receipt-001');
  assert.equal(winner.amount, '12.34');
  const winnerId = winner.orderKey.slice(shop.length + 1);
  assert.deepEqual(await repository.withOrderLock(winnerId, () => repository.claimReceipt({ ...winner, createdAt: '2026-02-01T00:00:00.000Z' })), { created: false });
  assert.equal((await repository.listReceipts(winner.orderKey)).length, 1);
  await assert.rejects(repository.claimReceipt({ ...winner, amount: '12.35' }), /already claimed/);
  await assert.rejects(repository.claimReceipt({ ...winner, quoteRevision: 2 }), /already claimed/);
});

sqlTest('existing native receipt prevents cross-platform claims and exact decimals remain unchanged', async (pool, repository) => {
  await pool.query(`INSERT INTO shusha_payment_receipt_registry VALUES($1,'evershop',$2,'USD',12.34,1,now(),'{}')`, ['SYNTHETIC-RECEIPT-001', 'synthetic-native-uuid']);
  await assert.rejects(repository.claimReceipt(receipt(1)), /already claimed/);
  assert.equal((await repository.getReceipt('SYNTHETIC-RECEIPT-001')).platform, 'evershop');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM shusha_bridge_payment_receipt')).rows[0].n, 0);
  await repository.claimReceipt(receipt(1, { reference: 'SYNTHETIC-RECEIPT-002', amount: '9999999999.99' }));
  assert.equal((await repository.getReceipt('SYNTHETIC-RECEIPT-002')).amount, '9999999999.99');
  await assert.rejects(repository.claimReceipt(receipt(1, { reference: 'SYNTHETIC-RECEIPT-003', amount: '1e3' })), /exact decimal/);
});

sqlTest('receipt registry and ledger roll back together on a ledger failure, then can retry original claim', async (pool, repository) => {
  await pool.query(`CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure'; END $$`);
  await pool.query('CREATE TRIGGER reject_receipt BEFORE INSERT ON shusha_bridge_payment_receipt FOR EACH ROW EXECUTE FUNCTION reject_receipt()');
  await assert.rejects(repository.withOrderLock(id(1), () => repository.claimReceipt(receipt(1))), /synthetic ledger failure/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM shusha_payment_receipt_registry')).rows[0].n, 0);
  await pool.query('DROP TRIGGER reject_receipt ON shusha_bridge_payment_receipt');
  assert.deepEqual(await repository.withOrderLock(id(1), () => repository.claimReceipt(receipt(1))), { created: true });
});

sqlTest('autocommit journal survives remote failure and order advisory locks serialize writers', async (pool, repository) => {
  await assert.rejects(repository.withOrderLock(id(1), async () => {
    await repository.saveOperation('synthetic-operation-001', operation(1, { status: 'in-flight' }));
    const external = await pool.query('SELECT record FROM shusha_bridge_payment_operation WHERE operation_key=$1', ['synthetic-operation-001']);
    assert.equal(external.rows[0].record.status, 'in-flight');
    throw new Error('synthetic lost remote response');
  }), /lost remote response/);
  assert.equal((await repository.getOperation('synthetic-operation-001')).status, 'in-flight');
  const log = [];
  await Promise.all([repository.withOrderLock(id(1), async () => {
    log.push('first-enter'); await new Promise(resolve => setTimeout(resolve, 20)); log.push('first-exit');
  }), repository.withOrderLock(id(1), async () => { log.push('second-enter'); })]);
  assert.deepEqual(log, ['first-enter', 'first-exit', 'second-enter']);
  await repository.saveOperation('synthetic-operation-001', operation(1, { status: 'complete' }));
  await assert.rejects(repository.saveOperation('synthetic-operation-001', operation(2)), /another intent/);
  await assert.rejects(repository.saveOperation('synthetic-operation-001', operation(1, { status: 'unknown' })), /another intent/);
});

sqlTest('quote history is immutable, version regressions roll back, and store bindings cannot leak', async (pool, repository) => {
  await repository.withOrderLock(id(1), () => repository.saveQuote(id(1), quote(1)));
  await repository.saveQuote(id(1), quote(1));
  await repository.saveQuote(id(1), quote(1, { pendingPaymentOperationKey: 'synthetic-operation-001' }));
  assert.equal((await repository.getQuote(id(1))).pendingPaymentOperationKey, 'synthetic-operation-001');
  await repository.saveQuote(id(1), quote(1, { pendingPaymentOperationKey: null, pendingFulfillmentOperationKey: 'synthetic-shipment-001' }));
  assert.equal((await repository.getQuote(id(1))).pendingFulfillmentOperationKey, 'synthetic-shipment-001');
  await repository.saveQuote(id(1), quote(1, { pendingFulfillmentOperationKey: null }));
  await assert.rejects(repository.saveQuote(id(1), quote(1, { amount: '20.00' })), /Historical payment version/);
  await repository.saveQuote(id(1), quote(1, { paymentVersion: 3, status: 'partial' }));
  await assert.rejects(repository.saveQuote(id(1), quote(1, { paymentVersion: 1 })), /moved forward/);
  assert.equal((await repository.getQuote(id(1))).paymentVersion, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM shusha_bridge_payment_quote_history')).rows[0].n, 2);
  const other = createPaymentRepository({ pool, shop: 'other-synthetic.myshopify.com' });
  assert.equal(await other.getQuote(id(1)), null);
  await assert.rejects(other.saveQuote(id(1), quote(1)), /identity/);
  await assert.rejects(other.listReceipts(key(1)), /another store/);
});

sqlTest('canonical pending and complete cancellations block finance under the order lock while cancellation can invalidate its quote', async (pool, repository) => {
  await repository.saveQuote(id(1), quote(1));
  const intent = { kind: 'order-cancel', shop, orderId: id(1), status: 'unknown' };
  await pool.query("INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('operation',$1,$2)", [`order-restock:${id(1)}`, JSON.stringify(intent)]);
  await assert.rejects(repository.withOrderLock(id(1), () => repository.assertOrderOperable(id(1))), /cancellation intent blocks/);
  await repository.withOrderLock(id(2), () => repository.assertOrderOperable(id(2)));
  // The plain lock must permit cancel itself to invalidate payment before its
  // remote mutation. Only financial/shipment services invoke the DI guard.
  await repository.withOrderLock(id(1), () => repository.saveQuote(id(1), quote(1, { paymentVersion: 3, status: 'inactive', wisePaymentUrl: null })));
  await pool.query("UPDATE shusha_bridge_mapping SET record=$2 WHERE kind='operation' AND source_key=$1", [`order-restock:${id(1)}`, JSON.stringify({ ...intent, status: 'complete' })]);
  await assert.rejects(repository.withOrderLock(id(1), () => repository.assertOrderOperable(id(1))), /cancellation intent blocks/);
  assert.equal((await repository.getQuote(id(1))).status, 'inactive');
});
