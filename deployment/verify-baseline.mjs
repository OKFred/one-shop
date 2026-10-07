#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureDatabase, createDatabasePool, parseArguments, snapshotCounts, validateSnapshot, hash, canonical } from './capture-baseline.mjs';

const pending = new Set(['pending', 'processing', 'unfullfilled', 'unfulfilled', '0']);
const shipped = new Set(['shipped', 'delivered', 'partially_shipped', 'partially_delivered', 'fullfilled', 'fulfilled']);
const paymentStatusMaps = Object.freeze({
  stripe: Object.freeze({ authorized: 'stripe_authorized', failed: 'stripe_failed', refunded: 'stripe_refunded', partial_refunded: 'stripe_partial_refunded', paid: 'stripe_captured' }),
  paypal: Object.freeze({ authorized: 'paypal_authorized', failed: 'paypal_failed', refunded: 'paypal_refunded', partial_refunded: 'paypal_partial_refunded', paid: 'paypal_captured' })
});

function nativeMigrationProven(before, after, module, target) {
  if (before.sourceVersion !== '1.2.2' || after.sourceVersion !== '2.2.1' || !Array.isArray(before.nativeMigrations) || !Array.isArray(after.nativeMigrations)) return false;
  const from = before.nativeMigrations.find(row => row.module === module)?.version;
  const to = after.nativeMigrations.find(row => row.module === module)?.version;
  if (to !== target) return false;
  if (!from) return true;
  if (!/^\d+\.\d+\.\d+$/.test(from)) return false;
  const a = from.split('.').map(Number);
  const b = target.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
}

export function isNativePaymentCanonicalization(before, after, original, current) {
  const method = original.values?.payment_method;
  const expected = paymentStatusMaps[method]?.[original.values?.payment_status];
  return !!expected && current.values?.payment_method === method && current.values?.payment_status === expected && nativeMigrationProven(before, after, method, '1.0.0');
}

function expectedCmsRoutes(snapshot) {
  const pages = snapshot.tables.cmsPages;
  const descriptions = snapshot.tables.cmsDescriptions;
  if (!pages?.exists || !descriptions?.exists || !pages.columns.includes('uuid') || !descriptions.columns.includes('content') || pages.records.some(row => !row.values?.uuid || row.values?.cms_page_id === undefined) || descriptions.records.some(row => !row.values?.url_key || row.values?.cms_page_description_cms_page_id === undefined || !/^[a-f0-9]{64}$/.test(row.fieldDigests.content || ''))) return null;
  const result = [];
  for (const page of pages.records) {
    const matching = descriptions.records.filter(row => String(row.values.cms_page_description_cms_page_id) === String(page.values.cms_page_id));
    if (matching.length !== 1) return null;
    result.push({ entity_uuid: page.values.uuid, entity_type: 'cms_page', request_path: `/${matching[0].values.url_key}`, target_path: `/page/${matching[0].values.url_key}` });
  }
  return result;
}

export function nativeCmsRewriteProof(before, after) {
  const routes = expectedCmsRoutes(before);
  const result = { baselineComplete: routes !== null, allowedKeys: new Set(), missingExpected: 0 };
  if (!routes || !nativeMigrationProven(before, after, 'cms', '1.4.0')) return result;
  const original = before.tables.urlRewrites?.records || [];
  const current = after.tables.urlRewrites?.records || [];
  const oldKeys = new Set(original.map(row => row.key));
  for (const route of routes) {
    const sameEntity = current.filter(row => row.values?.entity_uuid === route.entity_uuid);
    const samePath = current.filter(row => row.values?.request_path === route.request_path);
    const exact = sameEntity.filter(row => Object.entries(route).every(([field, value]) => row.values?.[field] === value));
    if (exact.length !== 1 || sameEntity.length !== 1 || samePath.length !== 1) { result.missingExpected++; continue; }
    const candidate = exact[0];
    if (oldKeys.has(candidate.key)) continue;
    if (original.some(row => row.values?.entity_uuid === route.entity_uuid || row.values?.request_path === route.request_path)) continue;
    result.allowedKeys.add(candidate.key);
  }
  return result;
}

export function compareSnapshots(before, after) {
  validateSnapshot(before);
  validateSnapshot(after);
  const changes = new Map();
  const nativeMappings = { paymentStatusCanonicalizations: 0, cmsPageRewritesAdded: 0 };
  const add = (area, field, count = 1) => {
    const key = `${area}.${field}`;
    changes.set(key, (changes.get(key) || 0) + count);
  };
  const cmsProof = nativeCmsRewriteProof(before, after);
  if (!cmsProof.baselineComplete) add('cmsRoutes', 'baseline_identity_or_path_missing');
  if (cmsProof.missingExpected) add('cmsRoutes', 'expected_mapping_missing_or_ambiguous', cmsProof.missingExpected);
  nativeMappings.cmsPageRewritesAdded = cmsProof.allowedKeys.size;
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
    const allowedAdded = name === 'urlRewrites' ? cmsProof.allowedKeys.size : 0;
    if (table.count + allowedAdded !== current.count) add(name, 'row_count');
    const currentRows = new Map(current.records.map(row => [row.key, row]));
    for (const row of table.records) {
      const next = currentRows.get(row.key);
      if (!next) { add(name, 'record_missing'); continue; }
      for (const [field, digest] of Object.entries(row.fieldDigests)) if (next.fieldDigests[field] !== digest) {
        if (name === 'orders' && field === 'payment_status' && isNativePaymentCanonicalization(before, after, row, next)) nativeMappings.paymentStatusCanonicalizations++;
        else add(name, field);
      }
    }
    const oldKeys = new Set(table.records.map(row => row.key));
    const extra = current.records.filter(row => !oldKeys.has(row.key) && !(name === 'urlRewrites' && cmsProof.allowedKeys.has(row.key))).length;
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
  return { status: changes.size ? 'mismatch' : 'verified', counts: snapshotCounts(after), nativeMappings, mismatches: [...changes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([field, count]) => ({ field, count })), beforeSnapshotSha256: before.contentSha256, afterSnapshotSha256: after.contentSha256 };
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
