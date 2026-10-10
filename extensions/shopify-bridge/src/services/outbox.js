import { randomUUID } from 'node:crypto';
import { integer, projectShopifyDelta, requireTransaction } from './inventory.js';

export const INVENTORY_ADJUST_MUTATION = `mutation BridgeInventoryDelta($input:InventoryAdjustQuantitiesInput!,$idempotencyKey:String!){
  inventoryAdjustQuantities(input:$input) @idempotent(key:$idempotencyKey){
    inventoryAdjustmentGroup{createdAt changes{name delta}} userErrors{code field}
  }
}`;
const INVENTORY_QUERY = `query BridgeInventoryQuantity($item:ID!,$location:ID!){
  inventoryItem(id:$item){inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}
}`;
// Reserve five minutes for bounded network retries before the 24-hour provider expiry.
export const IDEMPOTENCY_RETRY_WINDOW_MS = (24 * 60 - 5) * 60000;

/** Never return a possibly still-locked PostgreSQL session to the pool. */
export async function releaseAdvisoryOwner(owner, sql) {
  let failure;
  try { await owner.query(sql); }
  catch (error) { failure = error; }
  finally { owner.release(failure); }
  if (failure) throw failure;
}

export async function withTransaction(pool, work) {
  const connection = await pool.connect();
  let destroy;
  try {
    await connection.query('BEGIN'); connection.INTRANSACTION = true;
    const result = await work(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try { await connection.query('ROLLBACK'); }
    catch (rollbackError) { destroy = rollbackError; }
    throw error;
  }
  finally { connection.INTRANSACTION = false; connection.release(destroy); }
}

export async function enqueue(connection, { intentKey, kind, aggregateKey, payload }) {
  requireTransaction(connection);
  if (![intentKey, kind, aggregateKey].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 500)) {
    throw new Error('Invalid bridge outbox intent');
  }
  const inserted = await connection.query(`INSERT INTO shusha_bridge_outbox(id,intent_key,kind,aggregate_key,payload,state)
    VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT(intent_key) DO NOTHING RETURNING id`,
  [randomUUID(), intentKey, kind, aggregateKey, JSON.stringify(payload)]);
  return inserted.rows[0]?.id ?? null;
}

export function inventoryRequest({ id, payload, quantity, debt, mapping, idempotencyKey = randomUUID() }) {
  const projection = projectShopifyDelta(quantity, debt, payload.delta);
  for (const [field, type] of [['inventoryItemId', 'InventoryItem'], ['locationId', 'Location']]) {
    if (!new RegExp(`^gid://shopify/${type}/[0-9]+$`).test(mapping?.[field] || '')) throw new Error('Inventory mapping is incomplete');
  }
  return {
    query: INVENTORY_ADJUST_MUTATION,
    variables: {
      input: { name: 'available', reason: 'correction', referenceDocumentUri: `gid://shusha-bridge/InventoryDelta/${id}`,
        changes: [{ inventoryItemId: mapping.inventoryItemId, locationId: mapping.locationId,
          changeFromQuantity: integer(quantity), delta: integer(projection.delta) }] },
      idempotencyKey
    },
    nextDebt: projection.debt
  };
}

export function inventoryOutcome(data) {
  const result = data?.inventoryAdjustQuantities;
  if (result?.inventoryAdjustmentGroup && Array.isArray(result.userErrors) && !result.userErrors.length) return 'applied';
  const codes = result?.userErrors?.map((item) => item.code);
  if (codes?.length && codes.every((code) => code === 'CHANGE_FROM_QUANTITY_STALE')) return 'nonwrite';
  if (codes?.includes('IDEMPOTENCY_KEY_PARAMETER_MISMATCH')) return 'freeze';
  // Do not infer non-write from generic failures or a missing adjustment group.
  return 'unknown';
}

async function setState(pool, row, state, errorCode = null, { clearAttempt = false } = {}) {
  return withTransaction(pool, async (connection) => {
    await connection.query(`UPDATE shusha_bridge_outbox SET state=$2,last_error=$3,lease_until=NULL,
      available_at=NOW()+INTERVAL '1 minute',updated_at=NOW()
      ${clearAttempt ? ',idempotency_key=NULL,request_json=NULL,request_started_at=NULL' : ''} WHERE id=$1`, [row.id, state, errorCode]);
    if (state === 'frozen') await connection.query(`UPDATE shusha_bridge_inventory SET frozen=TRUE,freeze_reason=$2 WHERE sku=$1`, [row.aggregate_key, errorCode]);
  });
}

async function readQuantity(client, mapping) {
  const data = await client.request(INVENTORY_QUERY, { item: mapping.inventoryItemId, location: mapping.locationId });
  const quantity = data?.inventoryItem?.inventoryLevel?.quantities?.find((value) => value.name === 'available')?.quantity;
  return integer(quantity, 'Shopify available quantity');
}

async function applyEverShop(pool, row) {
  return withTransaction(pool, async (connection) => {
    const current = (await connection.query('SELECT * FROM shusha_bridge_outbox WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
    if (current.state === 'applied') return;
    // Native order_item's trigger locks the product row first. Keep that same
    // order so a checkout cannot deadlock with its incoming mirror delta.
    await connection.query(`SELECT i.product_inventory_product_id FROM product_inventory i
      JOIN shusha_bridge_inventory b ON b.product_id=i.product_inventory_product_id
      WHERE b.sku=$1 FOR UPDATE OF i`, [row.aggregate_key]);
    const inventory = (await connection.query('SELECT * FROM shusha_bridge_inventory WHERE sku=$1 FOR UPDATE', [row.aggregate_key])).rows[0];
    if (!inventory || inventory.frozen) throw new Error('Inventory SKU is unavailable or frozen');
    // The source ledger already changed central balance. Only mirror this one delta.
    const updated = await connection.query(`UPDATE product_inventory SET qty=qty+$2
      WHERE product_inventory_product_id=$1 AND manage_stock=TRUE RETURNING qty`, [inventory.product_id, integer(row.payload.delta)]);
    if (updated.rowCount !== 1) throw new Error('Native inventory mirror is not managed');
    await connection.query(`UPDATE shusha_bridge_outbox SET state='applied',lease_until=NULL,last_error=NULL,updated_at=NOW() WHERE id=$1`, [row.id]);
  });
}

async function prepareRequest(pool, row, { client, resolveInventory, now }) {
  if (row.request_json) return row.request_json;
  const mapping = await resolveInventory(row.aggregate_key);
  const quantity = await readQuantity(client, mapping);
  if (row.payload.opening && quantity !== 0) {
    await setState(pool, row, 'frozen', 'opening-shopify-quantity-is-not-zero');
    throw new Error('Opening Shopify quantity must be independently zero');
  }
  return withTransaction(pool, async (connection) => {
    const locked = (await connection.query('SELECT * FROM shusha_bridge_outbox WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
    if (locked.request_json) return locked.request_json;
    const inventory = (await connection.query('SELECT * FROM shusha_bridge_inventory WHERE sku=$1 FOR UPDATE', [row.aggregate_key])).rows[0];
    if (!inventory || inventory.frozen) throw new Error('Inventory SKU is unavailable or frozen');
    const request = inventoryRequest({ id: row.id, payload: row.payload, quantity, debt: integer(inventory.shopify_debt), mapping });
    await connection.query(`UPDATE shusha_bridge_outbox SET request_json=$2,idempotency_key=$3,
      request_started_at=$4,attempt_no=attempt_no+1,updated_at=NOW() WHERE id=$1`,
    [row.id, JSON.stringify(request), request.variables.idempotencyKey, new Date(now()).toISOString()]);
    return request;
  });
}

async function applyShopify(pool, row, options) {
  const { client, now } = options;
  if (row.request_started_at && now() - new Date(row.request_started_at).getTime() >= IDEMPOTENCY_RETRY_WINDOW_MS) {
    await setState(pool, row, 'frozen', 'inventory-idempotency-window-expired'); return 'frozen';
  }
  let request;
  try { request = await prepareRequest(pool, row, options); }
  catch (_) {
    const persisted = (await pool.query('SELECT state FROM shusha_bridge_outbox WHERE id=$1', [row.id])).rows[0];
    if (persisted.state !== 'frozen') await setState(pool, row, 'pending', 'inventory-read-or-mapping-required');
    return persisted.state === 'frozen' ? 'frozen' : 'pending';
  }
  let data;
  try {
    data = await client.request(request.query, request.variables, {
      kind: 'mutation', safeRetry: true, idempotencyKey: request.variables.idempotencyKey
    });
  } catch (_) {
    await setState(pool, row, 'unknown', 'inventory-mutation-outcome-unknown'); return 'unknown';
  }
  const outcome = inventoryOutcome(data);
  if (outcome === 'nonwrite') { await setState(pool, row, 'pending', 'inventory-cas-stale', { clearAttempt: true }); return 'pending'; }
  if (outcome === 'freeze') { await setState(pool, row, 'frozen', 'inventory-idempotency-parameter-mismatch'); return 'frozen'; }
  if (outcome === 'unknown') { await setState(pool, row, 'unknown', 'inventory-mutation-outcome-unknown'); return 'unknown'; }
  await withTransaction(pool, async (connection) => {
    const locked = (await connection.query('SELECT state,request_json FROM shusha_bridge_outbox WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
    if (locked.state === 'applied') return;
    if (locked.request_json?.variables?.idempotencyKey !== request.variables.idempotencyKey) throw new Error('Persisted inventory attempt changed');
    await connection.query('UPDATE shusha_bridge_inventory SET shopify_debt=$2 WHERE sku=$1', [row.aggregate_key, request.nextDebt]);
    await connection.query(`UPDATE shusha_bridge_outbox SET state='applied',lease_until=NULL,last_error=NULL,updated_at=NOW() WHERE id=$1`, [row.id]);
  });
  return 'applied';
}

/** Called by the existing native cron, not by an additional worker process. */
export async function processOutbox(pool, { client, writesEnabled = false, resolveInventory, limit = 20, now = Date.now, handlers = {}, allowedKinds = null } = {}) {
  if (!writesEnabled) return { enabled: false, processed: 0 };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid bounded outbox batch');
  if (allowedKinds !== null && (!Array.isArray(allowedKinds) || allowedKinds.some((kind) => typeof kind !== 'string'))) throw new Error('Invalid outbox kind filter');
  const owner = await pool.connect();
  let locked;
  try { locked = (await owner.query("SELECT pg_try_advisory_lock(hashtext('shusha:bridge:outbox')) AS locked")).rows[0].locked; }
  catch (error) { owner.release(error); throw error; }
  if (!locked) { owner.release(); return { enabled: true, busy: true, processed: 0 }; }
  let processed = 0;
  const outcomes = { applied: 0, pending: 0, unknown: 0, frozen: 0 };
  try {
    for (; processed < limit; processed += 1) {
      const row = await withTransaction(pool, async (connection) => {
        const candidate = (await connection.query(`SELECT o.* FROM shusha_bridge_outbox o
          LEFT JOIN shusha_bridge_inventory i ON i.sku=o.aggregate_key
          WHERE o.state IN ('pending','unknown','working') AND o.available_at<=NOW()
          AND ($1::text[] IS NULL OR o.kind=ANY($1::text[]))
          AND (o.lease_until IS NULL OR o.lease_until<NOW()) AND COALESCE(i.frozen,FALSE)=FALSE
          AND NOT EXISTS(SELECT 1 FROM shusha_bridge_outbox prior WHERE prior.aggregate_key=o.aggregate_key
            AND prior.state<>'applied' AND (prior.created_at,prior.id)<(o.created_at,o.id))
          ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`, [allowedKinds])).rows[0];
        if (!candidate) return null;
        await connection.query(`UPDATE shusha_bridge_outbox SET state='working',lease_until=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE id=$1`, [candidate.id]);
        return candidate;
      });
      if (!row) break;
      let outcome;
      if (row.kind === 'inventory.evershop') {
        try { await applyEverShop(pool, row); outcome = 'applied'; }
        catch (_) { await setState(pool, row, 'frozen', 'native-inventory-mirror-failed'); outcome = 'frozen'; }
      } else if (row.kind === 'inventory.shopify') {
        if (!client?.request || typeof resolveInventory !== 'function') { await setState(pool, row, 'pending', 'inventory-adapter-required'); outcome = 'pending'; }
        else outcome = await applyShopify(pool, row, { client, resolveInventory, now });
      } else if (typeof handlers[row.kind] === 'function') {
        // Generic handlers must perform their own persisted provider request/recovery.
        try {
          await handlers[row.kind](row, { pool, client });
          await withTransaction(pool, (connection) => connection.query(`UPDATE shusha_bridge_outbox SET state='applied',lease_until=NULL,last_error=NULL,updated_at=NOW() WHERE id=$1`, [row.id]));
          outcome = 'applied';
        } catch (_) { await setState(pool, row, 'frozen', 'bridge-handler-outcome-requires-review'); outcome = 'frozen'; }
      } else { await setState(pool, row, 'pending', 'bridge-handler-required'); outcome = 'pending'; }
      outcomes[outcome] += 1;
    }
    return { enabled: true, processed, ...outcomes };
  } finally {
    await releaseAdvisoryOwner(owner, "SELECT pg_advisory_unlock(hashtext('shusha:bridge:outbox'))");
  }
}
