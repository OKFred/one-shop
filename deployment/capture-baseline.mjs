#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');

export function canonical(value) {
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

const orderFields = ['order_id', 'uuid', 'order_number', 'status', 'cart_id', 'currency', 'customer_id', 'coupon', 'shipping_fee_excl_tax', 'shipping_fee_incl_tax', 'discount_amount', 'sub_total', 'sub_total_incl_tax', 'sub_total_with_discount', 'sub_total_with_discount_incl_tax', 'total_qty', 'total_weight', 'tax_amount', 'tax_amount_before_discount', 'shipping_tax_amount', 'grand_total', 'shipping_address_id', 'payment_method', 'payment_method_name', 'billing_address_id', 'shipment_status', 'payment_status', 'created_at'];
const nativeOrderFields = ['order_id', 'uuid', 'shipment_status', 'shipping_method', 'shipping_method_name', 'shipping_method_data', 'payment_method', 'shipping_fee_excl_tax', 'shipping_fee_incl_tax'];
const tablePolicies = [
  { name: 'orders', table: 'order', keys: ['order_id', 'uuid'], fields: orderFields, values: orderFields, required: true },
  { name: 'orderItems', table: 'order_item', keys: ['order_item_id', 'uuid'], values: ['order_item_id', 'uuid', 'order_item_order_id', 'product_id', 'product_sku', 'qty', 'product_price', 'product_price_incl_tax', 'final_price', 'final_price_incl_tax', 'tax_percent', 'tax_amount', 'tax_amount_before_discount', 'discount_amount', 'sub_total', 'line_total_with_discount', 'total', 'line_total_with_discount_incl_tax'], required: true },
  { name: 'customers', table: 'customer', keys: ['customer_id', 'uuid'], required: true },
  { name: 'admins', table: 'admin_user', keys: ['admin_user_id', 'uuid'], required: true },
  { name: 'customerAddresses', table: 'customer_address', keys: ['customer_address_id', 'uuid'], required: true },
  { name: 'orderAddresses', table: 'order_address', keys: ['order_address_id', 'uuid'], required: true },
  { name: 'products', table: 'product', keys: ['product_id', 'uuid'], fields: ['product_id', 'uuid', 'sku', 'price', 'status', 'visibility', 'variant_group_id'], values: ['product_id', 'uuid', 'sku', 'price', 'status', 'visibility', 'variant_group_id'], required: true },
  { name: 'inventory', table: 'product_inventory', keys: ['product_inventory_id', 'product_inventory_product_id'], values: ['product_inventory_id', 'product_inventory_product_id', 'qty', 'manage_stock', 'stock_availability'], required: true },
  { name: 'categoryIdentities', table: 'category', keys: ['category_id', 'uuid'], fields: ['category_id', 'uuid', 'parent_id', 'status'], values: ['category_id', 'uuid', 'parent_id', 'status'], required: true },
  { name: 'productPaths', table: 'product_description', keys: ['product_description_product_id'], fields: ['product_description_product_id', 'url_key'], values: ['product_description_product_id', 'url_key'], required: true },
  { name: 'categoryPaths', table: 'category_description', keys: ['category_description_category_id'], fields: ['category_description_category_id', 'url_key'], values: ['category_description_category_id', 'url_key'], required: true },
  { name: 'urlRewrites', table: 'url_rewrite', keys: ['url_rewrite_id'], fields: ['url_rewrite_id', 'request_path', 'target_path', 'entity_uuid', 'entity_type'], values: ['url_rewrite_id', 'request_path', 'target_path', 'entity_uuid', 'entity_type'], required: true },
  { name: 'paymentTransactions', table: 'payment_transaction', keys: ['payment_transaction_id', 'uuid'], required: true },
  { name: 'quotes', table: 'shusha_payment_quote', keys: ['order_id'] },
  { name: 'quoteAudit', table: 'shusha_payment_quote_audit', keys: ['audit_id'] },
  { name: 'receipts', table: 'shusha_payment_receipt', keys: ['receipt_id'] }
];

const identifier = value => { assert(/^[a-z_][a-z0-9_]*$/.test(value), 'Unsafe migration baseline identifier'); return `"${value}"`; };
const selectFields = (row, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]));
const projection = (columns, types) => columns.map(column => /^(?:timestamp|time|date)/.test(types[column] || '') ? `${identifier(column)}::text AS ${identifier(column)}` : identifier(column)).join(',');

export function snapshotRows(rows, { keys, fields, values = [], columnTypes = {} }) {
  const numeric = new Set(Object.entries(columnTypes).filter(([, type]) => ['numeric', 'decimal', 'double precision', 'real', 'integer', 'smallint', 'bigint'].includes(type)).map(([column]) => column));
  const normalize = (field, value) => {
    if (value instanceof Date) return value.toISOString();
    if (numeric.has(field) && value !== null && /^-?\d+(?:\.\d+)?$/.test(String(value))) {
      const [whole, fraction = ''] = String(value).split('.');
      const decimals = fraction.replace(/0+$/, '');
      return decimals ? `${whole}.${decimals}` : whole;
    }
    return value;
  };
  const columns = fields || Object.keys(columnTypes);
  const records = rows.map(row => {
    const selected = Object.fromEntries(columns.filter(field => Object.hasOwn(row, field)).map(field => [field, normalize(field, row[field])]));
    const identity = selectFields(selected, keys);
    assert(keys.every(key => Object.hasOwn(identity, key)), 'Baseline row identity is missing');
    return { identity, key: hash(identity), digest: hash(selected), fieldDigests: Object.fromEntries(Object.entries(selected).map(([field, value]) => [field, hash(canonical(value))])), ...(values.length ? { values: selectFields(selected, values) } : {}) };
  }).sort((a, b) => a.key.localeCompare(b.key));
  assert(new Set(records.map(row => row.key)).size === records.length, 'Baseline row identity is ambiguous');
  return { columns, columnTypes, keys, count: records.length, digest: hash(records.map(row => ({ key: row.key, digest: row.digest }))), records };
}

async function tableColumns(client, table) {
  const result = await client.query('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position', [table]);
  return Object.fromEntries(result.rows.map(row => [row.column_name, row.data_type]));
}

export async function captureDatabase(client, { sourceVersion = '1.2.2', baseline = null } = {}) {
  let transaction = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const tables = {};
    for (const policy of tablePolicies) {
      const types = await tableColumns(client, policy.table);
      const exists = Object.keys(types).length > 0;
      assert(exists || !policy.required, 'Required migration baseline table is missing');
      if (!exists) { tables[policy.name] = { table: policy.table, exists: false, count: 0, columns: [], records: [] }; continue; }
      const before = baseline?.tables[policy.name];
      const fields = before?.exists ? before.columns : policy.fields?.filter(field => Object.hasOwn(types, field)) || Object.keys(types);
      const missingColumns = fields.filter(field => !Object.hasOwn(types, field));
      const selected = fields.filter(field => Object.hasOwn(types, field));
      const result = await client.query(`SELECT ${projection(selected, types)} FROM ${identifier(policy.table)}`);
      tables[policy.name] = { table: policy.table, exists: true, missingColumns, ...snapshotRows(result.rows, { ...policy, fields: selected, columnTypes: before?.columnTypes || types }) };
    }
    const nativeTypes = await tableColumns(client, 'order');
    const nativeFields = nativeOrderFields.filter(field => Object.hasOwn(nativeTypes, field));
    const nativeOrders = (await client.query(`SELECT ${nativeFields.map(identifier).join(',')} FROM "order" ORDER BY order_id`)).rows;
    const shipmentTypes = await tableColumns(client, 'shipment');
    assert(Object.keys(shipmentTypes).length > 0, 'Native shipment table is missing');
    const shipments = (await client.query(`SELECT ${projection(Object.keys(shipmentTypes), shipmentTypes)} FROM shipment ORDER BY shipment_id`)).rows;
    const snapshot = { schemaVersion: 1, capturedAt: new Date().toISOString(), sourceVersion, tables, nativeShipments: { orders: nativeOrders, shipments } };
    snapshot.contentSha256 = hash(snapshot);
    await client.query('COMMIT'); transaction = false;
    return snapshot;
  } finally { if (transaction) await client.query('ROLLBACK').catch(() => {}); }
}

export function validateSnapshot(snapshot) {
  assert(snapshot?.schemaVersion === 1 && snapshot.tables && snapshot.nativeShipments && typeof snapshot.contentSha256 === 'string', 'Invalid migration baseline snapshot');
  const { contentSha256, ...body } = snapshot;
  assert(contentSha256 === hash(body), 'Migration baseline snapshot integrity differs');
  return snapshot;
}

export function parseArguments(argv, mode = 'capture') {
  const result = { help: false, sourceVersion: '1.2.2' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (['--output', '--baseline', '--source-version'].includes(arg)) {
      const value = argv[++i];
      assert(value && !value.startsWith('--'), 'Migration baseline argument value is missing');
      result[{ '--output': 'output', '--baseline': 'baseline', '--source-version': 'sourceVersion' }[arg]] = value;
    } else throw new Error('Unsupported migration baseline argument');
  }
  assert(result.help || (mode === 'capture' ? result.output : result.baseline), mode === 'capture' ? '--output private snapshot path is required' : '--baseline private snapshot path is required');
  return result;
}

export async function createDatabasePool(env = process.env) {
  assert(['DB_HOST', 'DB_USER', 'DB_NAME'].every(name => typeof env[name] === 'string' && env[name]), 'Private runtime database environment is incomplete');
  const { Pool } = await import('pg');
  let ssl = false;
  if (env.DB_SSLMODE && env.DB_SSLMODE !== 'disable') {
    ssl = { rejectUnauthorized: env.DB_SSLMODE !== 'no-verify' };
    if (env.DB_SSLROOTCERT) ssl.ca = await fs.readFile(env.DB_SSLROOTCERT, 'utf8');
    if (env.DB_SSLCERT) ssl.cert = await fs.readFile(env.DB_SSLCERT, 'utf8');
    if (env.DB_SSLKEY) ssl.key = await fs.readFile(env.DB_SSLKEY, 'utf8');
  }
  return new Pool({ host: env.DB_HOST, port: Number(env.DB_PORT || 5432), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, ssl, max: 1, connectionTimeoutMillis: 10000 });
}

export const snapshotCounts = snapshot => Object.fromEntries(Object.entries(snapshot.tables).map(([name, table]) => [name, table.count]));

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) { console.log('Usage: node deployment/capture-baseline.mjs --output /private/baseline.private.json [--source-version 1.2.2]\nRead-only consistent database capture. Requires DB_* runtime environment. Output contains private data; never commit or serve it.'); return; }
  assert(args.output.endsWith('.private.json'), 'Baseline output must use a .private.json filename in a private volume');
  const pool = await createDatabasePool();
  let client;
  try {
    client = await pool.connect();
    const snapshot = await captureDatabase(client, { sourceVersion: args.sourceVersion });
    await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.resolve(args.output), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(path.resolve(args.output), 0o600);
    console.log(JSON.stringify({ status: 'captured', counts: snapshotCounts(snapshot), nativeShipments: snapshot.nativeShipments.shipments.length, snapshotSha256: snapshot.contentSha256 }, null, 2));
  } finally { client?.release(); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('Migration baseline capture failed; private data and database error details are withheld'); process.exitCode = 1; });
