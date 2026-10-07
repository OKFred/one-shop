#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureDatabase, createDatabasePool, parseArguments, snapshotCounts, validateSnapshot, hash, canonical } from './capture-baseline.mjs';

const pending = new Set(['pending', 'processing', 'unfullfilled', 'unfulfilled', '0']);
const shipped = new Set(['shipped', 'delivered', 'partially_shipped', 'partially_delivered', 'fullfilled', 'fulfilled']);

export function compareSnapshots(before, after) {
  validateSnapshot(before);
  validateSnapshot(after);
  const changes = new Map();
  const add = (area, field, count = 1) => {
    const key = `${area}.${field}`;
    changes.set(key, (changes.get(key) || 0) + count);
  };
  for (const [name, table] of Object.entries(before.tables)) {
    const current = after.tables[name];
    if (!table.exists) {
      // Empty custom ledger tables may be added by migration; payment records
      // must not be created as a side effect of the upgrade.
      if (current?.exists && current.count) add(name, 'record_added', current.count);
      continue;
    }
    if (!current?.exists) { add(name, 'table_missing'); continue; }
    for (const field of table.columns) if (current.missingColumns?.includes(field) || !current.columns.includes(field)) add(name, `column_missing_${field}`);
    if (table.count !== current.count) add(name, 'row_count');
    const currentRows = new Map(current.records.map(row => [row.key, row]));
    for (const row of table.records) {
      const next = currentRows.get(row.key);
      if (!next) { add(name, 'record_missing'); continue; }
      for (const [field, digest] of Object.entries(row.fieldDigests)) if (next.fieldDigests[field] !== digest) add(name, field);
    }
    const oldKeys = new Set(table.records.map(row => row.key));
    const extra = current.records.filter(row => !oldKeys.has(row.key)).length;
    if (extra) add(name, 'record_added', extra);
  }

  const afterOrders = new Map(after.nativeShipments.orders.map(row => [String(row.order_id), row]));
  for (const order of before.nativeShipments.orders) {
    const next = afterOrders.get(String(order.order_id));
    if (!next) continue; // Already reported in order invariants.
    if ((pending.has(String(order.shipment_status)) || order.shipment_status === null) && shipped.has(String(next.shipment_status))) add('nativeShipments', 'pending_order_became_shipped');
    const oldMethod = order.shipping_method || order.shipping_method_data?.method_code;
    if (oldMethod === 'manual_quote' && order.payment_method === 'banktransfer' && (next.shipping_method_data?.provider_code !== 'shusha' || next.shipping_method_data?.method_code !== 'manual_quote')) add('nativeShipments', 'manual_quote_provider_identity');
  }
  const afterShipments = new Map(after.nativeShipments.shipments.map(row => [String(row.shipment_id), row]));
  const oldOrders = new Map(before.nativeShipments.orders.map(row => [String(row.order_id), row]));
  for (const shipment of before.nativeShipments.shipments) {
    const next = afterShipments.get(String(shipment.shipment_id));
    if (!next) { add('nativeShipments', 'legacy_shipment_missing'); continue; }
    for (const [field, value] of Object.entries(shipment)) if (hash(canonical(value)) !== hash(canonical(next[field]))) add('nativeShipments', `legacy_${field}`);
    const oldOrder = oldOrders.get(String(shipment.shipment_order_id));
    if ((pending.has(String(oldOrder?.shipment_status)) || oldOrder?.shipment_status === null) && shipped.has(String(next.status))) add('nativeShipments', 'pending_shipment_became_shipped');
  }
  const oldShipmentIds = new Set(before.nativeShipments.shipments.map(row => String(row.shipment_id)));
  const addedShipments = after.nativeShipments.shipments.filter(row => !oldShipmentIds.has(String(row.shipment_id))).length;
  if (addedShipments) add('nativeShipments', 'legacy_shipment_added', addedShipments);
  return { status: changes.size ? 'mismatch' : 'verified', counts: snapshotCounts(after), mismatches: [...changes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([field, count]) => ({ field, count })), beforeSnapshotSha256: before.contentSha256, afterSnapshotSha256: after.contentSha256 };
}

async function main() {
  const args = parseArguments(process.argv.slice(2), 'verify');
  if (args.help) { console.log('Usage: node deployment/verify-baseline.mjs --baseline /private/baseline.private.json\nRead-only verification against the candidate DB environment. Emits counts and mismatch labels only; blocks cutover on altered customer credentials, orders, stock, quotes, receipts, paths or false shipment advancement.'); return; }
  const before = validateSnapshot(JSON.parse(await fs.readFile(path.resolve(args.baseline), 'utf8')));
  const pool = await createDatabasePool();
  let client;
  try {
    client = await pool.connect();
    const after = await captureDatabase(client, { sourceVersion: '2.2.1', baseline: before });
    const result = compareSnapshots(before, after);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'verified') process.exitCode = 2;
  } finally { client?.release(); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('Migration baseline verification failed; private data and database error details are withheld'); process.exitCode = 1; });
