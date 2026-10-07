#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import api from './lib/supplier-price-api.cjs';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function parseArguments(argv) {
  const options = { apply: false, help: false };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('Unsupported price-sync argument; use --dry-run or --apply');
  }
  return options;
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Private price-sync directory must not be a symlink');
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
}

async function atomicWrite(filename, bytes) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  try { await fs.rename(temp, filename); }
  catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
}

const writeJson = (filename, value) => atomicWrite(filename, `${JSON.stringify(value, null, 2)}\n`);

// The only SQL write is product.price. Existing orders and inventory are never rewritten.
export async function transactPrices(client, plan, { apply = false, prepared = async () => {}, finished = async () => {} } = {}) {
  const locked = [];
  let transaction = false;
  let committed = false;
  let journal;
  try {
    for (const name of ['shusha-material-publication-v1', 'shusha-source-price-sync-v1']) {
      const acquired = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [name])).rows[0]?.locked === true;
      assert(acquired, 'Another managed source price sync or publication is running');
      locked.push(name);
    }
    await client.query('BEGIN'); transaction = true;
    const rows = (await client.query('SELECT p.product_id,p.uuid,p.sku,p.price,d.url_key FROM product p JOIN product_description d ON d.product_description_product_id=p.product_id WHERE p.sku=ANY($1::text[]) ORDER BY p.product_id FOR UPDATE OF p', [plan.map(row => row.storeSku)])).rows;
    assert(rows.length === plan.length, 'One or more managed existing products are missing or ambiguous; nothing is created');
    const before = plan.map(item => {
      const matches = rows.filter(row => row.sku === item.storeSku);
      const row = matches[0];
      assert(matches.length === 1 && row.url_key === item.storeUrlKey, 'Managed store SKU/path ownership differs');
      assert(Number.isFinite(Number(row.price)) && Number(row.price) >= 0, 'Managed existing source price is invalid');
      return { ...item, productId: row.product_id, uuid: row.uuid, oldPriceUsd: String(row.price) };
    });
    journal = { status: 'prepared', mode: apply ? 'apply' : 'dry-run', before, changes: before.filter(row => !row.skipReason && Number(row.oldPriceUsd) !== row.sourcePriceUsd), skipped: before.filter(row => row.skipReason) };
    await prepared(journal);
    if (apply) {
      for (const row of journal.changes) {
        const result = await client.query('UPDATE product SET price=$1 WHERE product_id=$2 AND uuid=$3 AND sku=$4', [row.sourcePriceUsd, row.productId, row.uuid, row.storeSku]);
        assert(result.rowCount === 1, 'Managed source price write affected an unexpected number of products');
      }
      const after = (await client.query('SELECT sku,price FROM product WHERE sku=ANY($1::text[])', [before.map(row => row.storeSku)])).rows;
      assert(after.length === before.length && before.every(row => after.some(item => item.sku === row.storeSku && Number(item.price) === (row.skipReason ? Number(row.oldPriceUsd) : row.sourcePriceUsd))), 'Source price transaction readback differs');
      await client.query('COMMIT'); transaction = false; committed = true;
      journal.transactionStatus = 'applied';
    } else { await client.query('ROLLBACK'); transaction = false; journal.transactionStatus = 'dry-run-complete'; }
    journal.status = journal.skipped.length ? 'partial' : journal.transactionStatus;
    journal.finishedAt = new Date().toISOString();
    await finished(journal);
    return journal;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (journal) {
      journal.status = committed ? 'applied-journal-failed' : 'failed';
      journal.finishedAt = new Date().toISOString();
      journal.error = api.redactError(error);
      await finished(journal).catch(() => {});
    }
    if (committed) throw new Error('Source prices committed, but final journal persistence failed; inspect the database and prepared snapshot before retrying');
    throw error;
  } finally {
    for (const name of locked.reverse()) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
  }
}

export async function runSync(options, { env = process.env, fetchImpl = fetch, runtime = null } = {}) {
  const privateDataDir = path.resolve(env.PRIVATE_DATA_DIR || path.join(process.cwd(), 'data'));
  const libraryDir = path.resolve(env.MATERIAL_LIBRARY_DIR || env.SHUSHA_MATERIAL_LIBRARY_DIR || path.join(privateDataDir, 'material-library'));
  const backupDir = path.resolve(env.SOURCE_SYNC_BACKUP_DIR || path.join(privateDataDir, 'source-price-backups'));
  const mapBytes = await fs.readFile(path.join(libraryDir, 'store-map.json'));
  const map = JSON.parse(mapBytes);
  api.validateMappings(map);
  const [feed, rate] = await Promise.all([api.fetchSupplierPrices({ env, fetchImpl }), api.fetchSourceUsdRate({ fetchImpl })]);
  const plan = api.planMappedPrices(map, feed, rate);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const directory = path.join(backupDir, runId);
  await privateDirectory(backupDir);
  await privateDirectory(directory);
  await atomicWrite(path.join(directory, 'supplier-prices.private.json'), feed.responseBytes);
  await atomicWrite(path.join(directory, 'source-app.private.js'), rate.scriptBytes);
  await atomicWrite(path.join(directory, 'source-homepage.private.html'), rate.homeBytes);
  const provenance = { schemaVersion: 1, runId, sourceCurrency: 'LKR', sourcePriceField: api.PRICE_FIELD, priceBasis: 'site-resale-display', displayCurrency: 'USD', usdDivisor: rate.usdDivisor, conversionPolicy: rate.conversionPolicy, apiSha256: feed.sha256, apiCapturedAt: feed.capturedAt, apiRowCount: feed.rowCount, sourceScriptSha256: rate.scriptSha256, sourceScriptCapturedAt: rate.capturedAt, sourceScriptUrl: rate.scriptUrl, mapSha256: sha(mapBytes), diagnostics: feed.diagnostics, inventoryUpdated: false, historicalOrdersUpdated: false };
  await writeJson(path.join(directory, 'provenance.private.json'), provenance);
  const require = createRequire(import.meta.url);
  if (!runtime) {
    const version = require('@evershop/evershop/package.json').version;
    assert(version === '2.2.1', 'Price sync requires the validated EverShop 2.2.1 runtime');
    assert(['DB_HOST', 'DB_USER', 'DB_NAME'].every(name => env[name]), 'Runtime database environment is incomplete');
    const { pool } = await import('@evershop/evershop/lib/postgres');
    const { refreshSetting, getStoreCurrency } = await import('@evershop/evershop/setting/services');
    runtime = { pool, version, refreshSetting, getStoreCurrency };
  }
  const { pool } = runtime;
  pool.options.connectionTimeoutMillis = 10000;
  let client;
  let journal;
  try {
    await runtime.refreshSetting();
    assert(runtime.getStoreCurrency() === 'USD', 'Managed source sync requires the USD store currency');
    client = await pool.connect();
    journal = await transactPrices(client, plan, {
      apply: options.apply,
      prepared: async value => {
        value.provenance = provenance;
        await writeJson(path.join(directory, 'snapshot.private.json'), { schemaVersion: 1, createdAt: new Date().toISOString(), appVersion: runtime.version, map, before: value.before, provenance });
        await writeJson(path.join(directory, 'journal.private.json'), value);
      },
      finished: value => writeJson(path.join(directory, 'journal.private.json'), value)
    });
  } finally { client?.release(); await pool.end(); }
  return { mode: 'supplier-price-sync', status: journal.status, transactionStatus: journal.transactionStatus, existingMappedSkus: plan.length, changedPrices: journal.changes.length, skipped: journal.skipped.map(row => ({ storeSku: row.storeSku, skipReason: row.skipReason })), skippedPricesRetained: true, supplierRows: feed.rowCount, supplierDiagnostics: feed.diagnostics, usdDivisor: rate.usdDivisor, sourcePriceField: api.PRICE_FIELD, sourceApiSha256: feed.sha256, sourceRateSha256: rate.scriptSha256, runId, inventoryUpdated: false, historicalOrdersUpdated: false };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/shusha-sync-prices.mjs [--dry-run | --apply]\nBackend-only supplier API sync for explicitly mapped existing SKUs. SUUSHA_PRICE_API_KEY is required. Raw price02 LKR uses the current source-site USD display rate; source USD prices only are written. Inventory and historical orders are untouched.');
    return;
  }
  const { config } = await import('dotenv');
  config({ quiet: true });
  const result = await runSync(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'partial') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`Supplier price sync failed: ${api.redactError(error)}`); process.exitCode = 1; });
