import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeShop } from './config.js';
import { paymentOrderId, operationKey, decimalMoney, normalizedReceiptReference } from './payments.js';

const quoteStatuses = new Set(['inactive', 'confirmed', 'partial', 'received', 'paid']);
const operationStatuses = new Set(['prepared', 'in-flight', 'staged', 'unknown', 'rejected', 'readback-mismatch', 'complete']);
const receiptColumns = `reference,platform,order_key AS "orderKey",currency,amount::text AS amount,
  quote_revision AS "quoteRevision",created_at AS "createdAt",record`;
const joinedReceiptColumns = `r.reference,r.platform,r.order_key AS "orderKey",r.currency,r.amount::text AS amount,
  r.quote_revision AS "quoteRevision",r.created_at AS "createdAt",r.record`;
function checkRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Private payment record is required');
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > 256 * 1024) throw new Error('Private payment record exceeds its bound');
  return json;
}
function receiptRecord(row) {
  if (!row) return null;
  // Database ownership/money always wins over a retained private JSON record.
  return { ...row.record, reference: row.reference, platform: row.platform, orderKey: row.orderKey,
    currency: row.currency, amount: decimalMoney(row.amount), quoteRevision: row.quoteRevision,
    createdAt: new Date(row.createdAt).toISOString() };
}

/** A shop-bound, private repository. Remote calls never occur in a transaction. */
export function createPaymentRepository({ pool, shop } = {}) {
  shop = normalizeShop(shop);
  if (typeof pool?.connect !== 'function' || typeof pool?.query !== 'function') throw new Error('Native PostgreSQL pool is required');
  const context = new AsyncLocalStorage();
  const db = () => context.getStore()?.client || pool;
  const keyFor = id => `${shop}:${paymentOrderId(id)}`;

  async function withOrderLock(id, work) {
    const key = `shusha-shopify-payment:${keyFor(id)}`;
    if (typeof work !== 'function') throw new Error('Payment lock callback is required');
    const held = context.getStore();
    if (held?.orderKey === key) return work();
    if (held) throw new Error('Nested payment locks for different orders are not permitted');
    const client = await pool.connect(); let locked = false; let destroy;
    const state = { client, orderKey: key, transaction: false, destroy: null };
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]); locked = true;
      return await context.run(state, work);
    } catch (error) {
      if (!locked) destroy = error;
      throw error;
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
        catch (error) { destroy = error; }
      }
      destroy ||= state.destroy;
      client.release(destroy);
      if (destroy) throw new Error('Payment session lock release failed; connection discarded');
    }
  }
  async function transaction(work) {
    const current = context.getStore();
    if (current?.transaction) throw new Error('Nested receipt transaction is not permitted');
    const client = current?.client || await pool.connect(); let destroy;
    if (current) current.transaction = true;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { destroy = rollbackError; }
      throw error;
    } finally {
      if (current) { current.transaction = false; if (destroy) current.destroy = destroy; }
      else client.release(destroy);
    }
  }
  async function getQuote(id) {
    return (await db().query('SELECT record FROM shusha_bridge_payment_quote WHERE shop=$1 AND order_id=$2', [shop, paymentOrderId(id)])).rows[0]?.record || null;
  }
  async function saveQuote(id, quote) {
    paymentOrderId(id);
    if (quote?.shop !== shop || quote.orderId !== id || !Number.isSafeInteger(quote.revision) || quote.revision < 0 || !Number.isSafeInteger(quote.paymentVersion) || quote.paymentVersion < 1 || !quoteStatuses.has(quote.status)) throw new Error('Private quote identity or version is invalid');
    const json = checkRecord(quote);
    // Pending journal pointers are operational guards, not new customer payment
    // versions. Their durable current state may change while money/receiving
    // details and the version's historical snapshot remain immutable.
    const { pendingPaymentOperationKey, pendingFulfillmentOperationKey, ...versionSnapshot } = quote;
    const historyJson = checkRecord(versionSnapshot);
    await transaction(async client => {
      await client.query(`INSERT INTO shusha_bridge_payment_quote_history(shop,order_id,payment_version,revision,record)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [shop, id, quote.paymentVersion, quote.revision, historyJson]);
      const history = (await client.query(`SELECT record=$4::jsonb AS identical FROM shusha_bridge_payment_quote_history
        WHERE shop=$1 AND order_id=$2 AND payment_version=$3`, [shop, id, quote.paymentVersion, historyJson])).rows[0];
      if (history?.identical !== true) throw new Error('Historical payment version cannot be overwritten');
      const saved = await client.query(`INSERT INTO shusha_bridge_payment_quote(shop,order_id,revision,payment_version,status,record)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(shop,order_id) DO UPDATE SET
        revision=EXCLUDED.revision,payment_version=EXCLUDED.payment_version,status=EXCLUDED.status,record=EXCLUDED.record,updated_at=now()
        WHERE shusha_bridge_payment_quote.revision<=EXCLUDED.revision AND shusha_bridge_payment_quote.payment_version<=EXCLUDED.payment_version
        RETURNING order_id`, [shop, id, quote.revision, quote.paymentVersion, quote.status, json]);
      if (saved.rowCount !== 1) throw new Error('Quote revision or payment version moved forward');
    });
  }
  async function getOperation(key) {
    return (await db().query('SELECT record FROM shusha_bridge_payment_operation WHERE shop=$1 AND operation_key=$2', [shop, operationKey(key)])).rows[0]?.record || null;
  }
  async function saveOperation(key, record) {
    operationKey(key); paymentOrderId(record?.orderId);
    if (record.key !== key || record.shop !== shop || !['quote', 'paid', 'fulfillment'].includes(record.kind) || !operationStatuses.has(record.status) || !/^[a-f0-9]{64}$/.test(record.inputHash || '')) throw new Error('Private payment journal identity is invalid');
    const saved = await db().query(`INSERT INTO shusha_bridge_payment_operation(shop,operation_key,order_id,kind,input_hash,status,record)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(shop,operation_key) DO UPDATE SET
      status=EXCLUDED.status,record=EXCLUDED.record,updated_at=now()
      WHERE shusha_bridge_payment_operation.order_id=EXCLUDED.order_id AND shusha_bridge_payment_operation.kind=EXCLUDED.kind
      AND shusha_bridge_payment_operation.input_hash=EXCLUDED.input_hash
      AND (shusha_bridge_payment_operation.status<>'complete' OR EXCLUDED.status='complete') RETURNING operation_key`,
    [shop, key, record.orderId, record.kind, record.inputHash, record.status, checkRecord(record)]);
    if (saved.rowCount !== 1) throw new Error('Operation key is already bound to another intent');
  }
  async function getReceipt(reference) {
    reference = normalizedReceiptReference(reference);
    return receiptRecord((await db().query(`SELECT ${receiptColumns} FROM shusha_payment_receipt_registry WHERE reference=$1`, [reference])).rows[0]);
  }
  async function claimReceipt(receipt) {
    const reference = normalizedReceiptReference(receipt?.reference);
    if (receipt.reference !== reference || receipt.platform !== 'shopify' || receipt.currency !== 'USD' || !Number.isSafeInteger(receipt.quoteRevision) || receipt.quoteRevision < 1 || !receipt.orderKey?.startsWith(`${shop}:`)) throw new Error('Canonical Shopify receipt ownership is required');
    const orderId = paymentOrderId(receipt.orderKey.slice(shop.length + 1));
    const amount = decimalMoney(receipt.amount);
    const createdAt = new Date(receipt.createdAt);
    if (!Number.isFinite(createdAt.valueOf())) throw new Error('Actual receipt timestamp is required');
    const canonical = { ...receipt, reference, amount, createdAt: createdAt.toISOString() };
    return transaction(async client => {
      const inserted = await client.query(`INSERT INTO shusha_payment_receipt_registry(reference,platform,order_key,currency,amount,quote_revision,created_at,record)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(reference) DO NOTHING RETURNING reference`,
      [reference, canonical.platform, canonical.orderKey, canonical.currency, amount, canonical.quoteRevision, canonical.createdAt, checkRecord(canonical)]);
      const existing = receiptRecord((await client.query(`SELECT ${receiptColumns} FROM shusha_payment_receipt_registry WHERE reference=$1 FOR UPDATE`, [reference])).rows[0]);
      if (!existing || ['platform', 'orderKey', 'currency', 'amount', 'quoteRevision'].some(field => existing[field] !== canonical[field])) throw new Error('Actual receipt is already claimed by another order or amount');
      await client.query(`INSERT INTO shusha_bridge_payment_receipt(reference,shop,order_id) VALUES($1,$2,$3)
        ON CONFLICT(reference) DO NOTHING`, [reference, shop, orderId]);
      const ledger = (await client.query('SELECT shop,order_id AS "orderId" FROM shusha_bridge_payment_receipt WHERE reference=$1', [reference])).rows[0];
      if (ledger?.shop !== shop || ledger.orderId !== orderId) throw new Error('Private receipt ledger ownership differs');
      return { created: inserted.rowCount === 1 };
    });
  }
  async function listReceipts(orderKey) {
    if (typeof orderKey !== 'string' || !orderKey.startsWith(`${shop}:`)) throw new Error('Receipt list belongs to another store');
    const orderId = paymentOrderId(orderKey.slice(shop.length + 1));
    const rows = (await db().query(`SELECT ${joinedReceiptColumns} FROM shusha_bridge_payment_receipt l JOIN shusha_payment_receipt_registry r ON r.reference=l.reference
      WHERE l.shop=$1 AND l.order_id=$2 ORDER BY r.created_at,r.reference`, [shop, orderId])).rows;
    return rows.map(row => {
      const receipt = receiptRecord(row);
      if (receipt.platform !== 'shopify' || receipt.orderKey !== orderKey) throw new Error('Global receipt ledger belongs to another order');
      return receipt;
    });
  }
  async function assertOrderOperable(id) {
    paymentOrderId(id);
    const intent = (await db().query("SELECT record FROM shusha_bridge_mapping WHERE kind='operation' AND source_key=$1", [`order-restock:${id}`])).rows[0]?.record;
    // A completed cancellation is also terminal for new financial/shipment
    // operations. Its independently verified native cancellation must not be
    // bypassed by a stale provider read or by inventing another operation key.
    if (intent) throw new Error('A canonical cancellation intent blocks this order; review its original journal');
  }
  return Object.freeze({ withOrderLock, getQuote, saveQuote, getOperation, saveOperation, getReceipt, claimReceipt, listReceipts, assertOrderOperable });
}
