'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const api = require('../../scripts/lib/supplier-price-api.cjs');
const modulePath = pathToFileURL(path.resolve(__dirname, '../../scripts/shusha-sync-prices.mjs')).href;
const mapping = { schemaVersion: 1, mappings: [{ storeSku: 'SHUSHA-L9998', sourceId: 'L9998', sourceVariantSku: 'L9998testm', storeUrlKey: 'l9998', priceBasis: 'site-resale-display' }] };
const currencyScript = '// All prices are stored/served in LKR.\nconst CUR_RATES = { LKR: 1, USD: 400 };\nfunction money(n) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }\nfunction toCur(n) { return (parseFloat(n) || 0) / curRate(); }';
const rate = { usdDivisor: 400, scriptSha256: 'synthetic-currency-script-hash' };
const makeFeed = rows => ({ ...api.parsePriceRows(rows), currency: 'LKR', priceField: api.PRICE_FIELD, capturedAt: '2026-01-01T00:00:00.000Z', sha256: 'synthetic-price-response-hash' });
const row = (overrides = {}) => ({ sku: 'L9998testm', stock_qty: '2', unit_sales_price_02: '1010.00', ...overrides });

test('source display USD matches the website two-decimal formatter', () => {
  assert.equal(api.sourceUsdDivisor(currencyScript), 400);
  assert.equal(api.sourceDisplayUsd(1010, 400), 2.53);
  assert.equal(api.sourceDisplayUsd(1000, 400), 2.5);
  assert.throws(() => api.sourceUsdDivisor(currencyScript.replace('USD: 400', 'GBP: 400')), /divisor/);
  assert.throws(() => api.sourceUsdDivisor(currencyScript.replace('maximumFractionDigits: 2', 'maximumFractionDigits: 3')), /rounding/);
});

test('invalid unrelated rows remain diagnostics and do not discard valid managed prices', () => {
  const feed = makeFeed([row(), row({ sku: 'OTHER A', unit_sales_price_02: null }), row({ sku: 'other-null', unit_sales_price_02: null }), row({ sku: 'other-zero', unit_sales_price_02: '0' })]);
  const plan = api.planMappedPrices(mapping, feed, rate);
  assert.equal(plan[0].sourcePriceLkr, 1010);
  assert.equal(plan[0].sourcePriceUsd, 2.53);
  assert.equal(plan[0].skipReason, null);
  assert.equal(feed.diagnostics.invalidSkuRows, 1);
  assert.equal(feed.diagnostics.invalidPriceRows, 1);
  assert.equal(feed.diagnostics.zeroPriceRows, 1);
});

test('managed missing, ambiguous, invalid, unavailable and case-mismatched rows retain old prices', () => {
  const cases = [
    [[row({ sku: 'other' })], 'supplier-source-sku-missing'],
    [[row(), row()], 'supplier-source-sku-ambiguous'],
    [[row({ unit_sales_price_02: null })], 'supplier-source-price-missing-or-invalid'],
    [[row({ unit_sales_price_02: '0' })], 'supplier-source-price-missing-or-invalid'],
    [[row({ unit_sales_price_02: '1e3' })], 'supplier-source-price-missing-or-invalid'],
    [[row({ stock_qty: null })], 'supplier-source-stock-invalid'],
    [[row({ stock_qty: '0' })], 'supplier-source-variant-unavailable'],
    [[row({ sku: 'l9998testm' })], 'supplier-source-sku-missing']
  ];
  for (const [rows, reason] of cases) {
    const item = api.planMappedPrices(mapping, makeFeed(rows), rate)[0];
    assert.equal(item.skipReason, reason);
    assert.equal(item.sourcePriceUsd, null);
  }
});

test('error envelopes, field changes and unsafe mappings stop before any writes', () => {
  assert.throws(() => api.parsePriceRows({ error: 'unauthorized' }), /array/);
  assert.throws(() => api.parsePriceRows([{ sku: 'example', price: '100' }]), /schema/);
  assert.throws(() => api.validateMappings({ ...mapping, mappings: [mapping.mappings[0], mapping.mappings[0]] }), /Duplicate/);
  assert.throws(() => api.validateMappings({ ...mapping, mappings: [{ ...mapping.mappings[0], storeUrlKey: 'another' }] }), /public URL/);
  assert.throws(() => api.validateMappings({ ...mapping, mappings: [{ ...mapping.mappings[0], sourceVariantSku: null }] }), /exact source variant/);
  assert.throws(() => api.planMappedPrices(mapping, { ...makeFeed([row()]), currency: 'USD' }, rate), /currency/);
});

test('API is backend GET, takes credential only from environment and never returns credential URL', async () => {
  let request;
  const env = { SUUSHA_PRICE_API_KEY: 'example-only-test-token' };
  const feed = await api.fetchSupplierPrices({ env, fetchImpl: async (url, init) => {
    request = { url: new URL(url), init };
    return new Response(JSON.stringify([row()]), { status: 200 });
  } });
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.redirect, 'manual');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.url.searchParams.get('api_key'), env.SUUSHA_PRICE_API_KEY);
  assert.equal(feed.rowCount, 1);
  assert.match(feed.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(feed).includes(env.SUUSHA_PRICE_API_KEY), false);
  await assert.rejects(api.fetchSupplierPrices({ env: {} }), /is required/);
  await assert.rejects(api.fetchSupplierPrices({ env: { ...env, SUUSHA_PRICE_API_URL: 'https://other.example/Excel/api.php' } }), /approved HTTPS endpoint/);
});

test('redirects and URL-containing fetch errors are sanitized without leaking credentials', async () => {
  const env = { SUUSHA_PRICE_API_KEY: 'example-only-test-token' };
  await assert.rejects(api.fetchSupplierPrices({ env, fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://other.example/' } }) }), /HTTP 302/);
  await assert.rejects(api.fetchSupplierPrices({ env, fetchImpl: async url => { throw new Error(`Fetch failed ${url.href}`); } }), error => !error.message.includes(env.SUUSHA_PRICE_API_KEY) && !error.message.includes('api_key'));
  assert.equal(api.redactError(new Error('failed ?api_key=example-only-test-token'), env).includes(env.SUUSHA_PRICE_API_KEY), false);
});

test('live source display rate is discovered from expected source script and hashed', async () => {
  const urls = [];
  const result = await api.fetchSourceUsdRate({ fetchImpl: async url => {
    urls.push(url.href);
    return new Response(url.pathname === '/' ? '<script src="/assets/app.js?v=test"></script>' : currencyScript);
  } });
  assert.equal(result.usdDivisor, 400);
  assert.equal(urls.length, 2);
  assert.match(result.scriptSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(api.fetchSourceUsdRate({ fetchImpl: async () => new Response('<script src="https://other.example/assets/app.js"></script>') }), /expected public currency script/);
});

function fakeClient({ oldPrice = '1.00', urlKey = 'l9998', locked = true, wrongReadback = false, writeFails = false } = {}) {
  const calls = [];
  let price = oldPrice;
  return { calls, async query(sql, args = []) {
    calls.push({ sql, args });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    if (sql.includes('JOIN product_description')) return { rows: [{ product_id: 7, uuid: 'synthetic-product-uuid', sku: 'SHUSHA-L9998', price, url_key: urlKey }] };
    if (sql.startsWith('UPDATE product')) {
      if (writeFails) throw new Error('synthetic write failure');
      price = String(args[0]);
      return { rowCount: 1 };
    }
    if (sql.startsWith('SELECT sku,price')) return { rows: [{ sku: 'SHUSHA-L9998', price: wrongReadback ? '9.00' : price }] };
    return { rows: [] };
  } };
}

test('dry-run snapshots and rolls back with no update; apply changes only product source price', async () => {
  const { transactPrices } = await import(modulePath);
  const plan = api.planMappedPrices(mapping, makeFeed([row()]), rate);
  const dryClient = fakeClient();
  let prepared = false;
  const dry = await transactPrices(dryClient, plan, { prepared: async () => { prepared = true; } });
  assert.equal(prepared, true);
  assert.equal(dry.status, 'dry-run-complete');
  assert.equal(dryClient.calls.some(call => call.sql.startsWith('UPDATE')), false);
  assert.equal(dryClient.calls.some(call => call.sql === 'ROLLBACK'), true);
  const client = fakeClient();
  const applied = await transactPrices(client, plan, { apply: true });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.changes.length, 1);
  const writes = client.calls.filter(call => call.sql.startsWith('UPDATE'));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /^UPDATE product SET price=/);
  assert.equal(client.calls.some(call => /inventory|order_item|UPDATE "?order/.test(call.sql)), false);
});

test('partial managed row retains its old price with an applied partial journal', async () => {
  const { transactPrices } = await import(modulePath);
  const plan = api.planMappedPrices(mapping, makeFeed([row({ unit_sales_price_02: null })]), rate);
  const client = fakeClient();
  const result = await transactPrices(client, plan, { apply: true });
  assert.equal(result.status, 'partial');
  assert.equal(result.transactionStatus, 'applied');
  assert.equal(result.skipped.length, 1);
  assert.equal(client.calls.some(call => call.sql.startsWith('UPDATE')), false);
});

test('lock, ownership, snapshot failure and transaction readback failures never commit', async () => {
  const { transactPrices } = await import(modulePath);
  const plan = api.planMappedPrices(mapping, makeFeed([row()]), rate);
  const clients = [fakeClient({ locked: false }), fakeClient({ urlKey: 'another' }), fakeClient({ wrongReadback: true }), fakeClient({ writeFails: true })];
  for (const client of clients) {
    await assert.rejects(transactPrices(client, plan, { apply: true }));
    assert.equal(client.calls.some(call => call.sql === 'COMMIT'), false);
  }
  const client = fakeClient();
  await assert.rejects(transactPrices(client, plan, { apply: true, prepared: async () => { throw new Error('snapshot unavailable'); } }), /snapshot/);
  assert.equal(client.calls.some(call => call.sql.startsWith('UPDATE')), false);
  assert.equal(client.calls.some(call => call.sql === 'ROLLBACK'), true);
});

test('post-commit journal failure is identified as committed rather than failed transaction', async () => {
  const { transactPrices } = await import(modulePath);
  const plan = api.planMappedPrices(mapping, makeFeed([row()]), rate);
  const client = fakeClient();
  let lastStatus;
  await assert.rejects(transactPrices(client, plan, { apply: true, finished: async value => { lastStatus = value.status; throw new Error('journal disk unavailable'); } }), /committed/);
  assert.equal(lastStatus, 'applied-journal-failed');
  assert.equal(client.calls.some(call => call.sql === 'COMMIT'), true);
  assert.equal(client.calls.some(call => call.sql === 'ROLLBACK'), false);
});

test('complete backend dry-run caches provenance privately without storing its credential', async () => {
  const { runSync } = await import(modulePath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-supplier-test-'));
  const library = path.join(directory, 'material-library');
  const backup = path.join(directory, 'source-price-backups');
  try {
    await fs.mkdir(library);
    await fs.writeFile(path.join(library, 'store-map.json'), JSON.stringify(mapping));
    const client = fakeClient();
    let refreshed = false;
    let ended = false;
    let released = false;
    client.release = () => { released = true; };
    const runtime = {
      version: '2.2.1',
      pool: { options: {}, connect: async () => client, end: async () => { ended = true; } },
      refreshSetting: async () => { refreshed = true; },
      getStoreCurrency: () => { assert.equal(refreshed, true); return 'USD'; }
    };
    const env = { SUUSHA_PRICE_API_KEY: 'example-only-test-token', MATERIAL_LIBRARY_DIR: library, SOURCE_SYNC_BACKUP_DIR: backup };
    const result = await runSync({ apply: false }, {
      env, runtime,
      fetchImpl: async url => new Response(url.hostname === 'suusha.com' ? JSON.stringify([row()]) : url.pathname === '/' ? '<script src="/assets/app.js?v=test"></script>' : currencyScript)
    });
    assert.equal(result.status, 'dry-run-complete');
    assert.equal(result.existingMappedSkus, 1);
    assert.equal(result.usdDivisor, 400);
    assert.equal(result.inventoryUpdated, false);
    assert.equal(result.historicalOrdersUpdated, false);
    assert.equal(ended && released, true);
    const runDirectory = path.join(backup, result.runId);
    const names = await fs.readdir(runDirectory);
    assert.equal(names.includes('snapshot.private.json'), true);
    assert.equal(names.includes('journal.private.json'), true);
    for (const filename of names) assert.equal((await fs.readFile(path.join(runDirectory, filename), 'utf8')).includes(env.SUUSHA_PRICE_API_KEY), false);
    const snapshot = JSON.parse(await fs.readFile(path.join(runDirectory, 'snapshot.private.json'), 'utf8'));
    assert.equal(snapshot.before[0].sourcePriceLkr, 1010);
    assert.equal(snapshot.before[0].sourcePriceUsd, 2.53);
    assert.equal(snapshot.provenance.sourceCurrency, 'LKR');
    assert.match(snapshot.provenance.apiSha256, /^[a-f0-9]{64}$/);
  } finally {
    // Remove only the exact directory created by this test, within the system temp root.
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(directory), /^shusha-supplier-test-/);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
