'use strict';

// Server/job-only adapter. Never expose the supplier credential to a browser.
const crypto = require('node:crypto');
const API_URL = 'https://suusha.com/Excel/api.php';
const SOURCE_URL = 'https://wh.suusha.com/';
const PRICE_FIELD = 'unit_sales_price_02';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const assert = (ok, message) => { if (!ok) throw new Error(message); };

function redactError(error, env = process.env) {
  let message = String(error?.message || error);
  for (const name of ['SUUSHA_PRICE_API_KEY', 'APIKEY', 'DB_PASSWORD', 'DATABASE_URL']) {
    if (env[name]) message = message.split(env[name]).join('[REDACTED]');
  }
  return message.replace(/([?&]api_key=)[^\s&#"']*/gi, '$1[REDACTED]');
}

async function readBytes(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  assert(!Number.isFinite(length) || length <= maxBytes, 'Supplier response exceeds the byte limit');
  const chunks = [];
  let lengthRead = 0;
  for await (const chunk of response.body) {
    lengthRead += chunk.length;
    if (lengthRead > maxBytes) throw new Error('Supplier response exceeds the byte limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function requestBytes(url, { fetchImpl = fetch, maxBytes = 16 * 1024 * 1024, timeoutMs = 25000 } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { Accept: 'application/json, text/html, text/javascript', 'Cache-Control': 'no-cache', 'User-Agent': 'SHUSHA-Source-Price-Sync/2.0' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    // Fetch exceptions may contain the full credential-bearing URL.
    throw new Error('Supplier request failed or timed out');
  }
  if (!response.ok || response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Supplier returned HTTP ${response.status}; redirects and credential forwarding are disabled`);
  }
  try { return await readBytes(response, maxBytes); }
  catch { throw new Error('Supplier response could not be read within its byte limit'); }
}

function decimal(value, { integer = false } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!(integer ? /^\d{1,12}$/ : /^\d{1,12}(?:\.\d{1,2})?$/).test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && (!integer || Number.isSafeInteger(number)) ? number : null;
}

function parsePriceRows(rows) {
  assert(Array.isArray(rows) && rows.length > 0 && rows.length <= 100000, 'Supplier price response must be a bounded nonempty array');
  const bySku = new Map();
  const diagnostics = { invalidSkuRows: 0, invalidPriceRows: 0, zeroPriceRows: 0, invalidStockRows: 0, duplicateSkuRows: 0 };
  for (const row of rows) {
    assert(row && typeof row === 'object' && !Array.isArray(row) && ['sku', 'stock_qty', PRICE_FIELD].every(key => Object.hasOwn(row, key)), 'Supplier price response schema changed');
    if (typeof row.sku !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(row.sku)) { diagnostics.invalidSkuRows++; continue; }
    const lkr = decimal(row[PRICE_FIELD]);
    const stockQty = decimal(row.stock_qty, { integer: true });
    if (lkr === null) diagnostics.invalidPriceRows++;
    if (lkr === 0) diagnostics.zeroPriceRows++;
    if (stockQty === null) diagnostics.invalidStockRows++;
    const entry = { sourceSku: row.sku, lkr, stockQty, ambiguous: false };
    if (bySku.has(row.sku)) { diagnostics.duplicateSkuRows++; bySku.set(row.sku, { ...entry, ambiguous: true }); }
    else bySku.set(row.sku, entry);
  }
  return { bySku, rowCount: rows.length, diagnostics };
}

async function fetchSupplierPrices({ env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  assert(typeof env.SUUSHA_PRICE_API_KEY === 'string' && env.SUUSHA_PRICE_API_KEY.trim(), 'SUUSHA_PRICE_API_KEY is required for backend price sync');
  let url;
  try { url = new URL(env.SUUSHA_PRICE_API_URL || API_URL); }
  catch { throw new Error('Invalid supplier price API endpoint'); }
  assert(url.protocol === 'https:' && url.hostname === 'suusha.com' && url.pathname === '/Excel/api.php' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443'), 'Supplier price API endpoint must be the approved HTTPS endpoint without query parameters');
  url.searchParams.set('api_key', env.SUUSHA_PRICE_API_KEY.trim());
  const bytes = await requestBytes(url, { fetchImpl });
  let rows;
  try { rows = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Supplier price API returned invalid JSON'); }
  return { ...parsePriceRows(rows), responseBytes: bytes, sha256: hash(bytes), capturedAt: now().toISOString(), currency: 'LKR', priceField: PRICE_FIELD };
}

function sourceUsdDivisor(script) {
  assert(/prices are stored\/served in LKR/i.test(script), 'Source script no longer confirms the LKR price currency');
  const rates = script.match(/const\s+CUR_RATES\s*=\s*\{([^}]+)\}/);
  const rate = Number(rates?.[1].match(/\bUSD\s*:\s*([0-9.]+)/)?.[1]);
  assert(Number.isFinite(rate) && rate > 0 && rate < 10000000, 'Source USD display divisor is missing or invalid');
  assert(/minimumFractionDigits\s*:\s*2/.test(script) && /maximumFractionDigits\s*:\s*2/.test(script) && /function\s+toCur\s*\([^)]*\)\s*\{[^}]*\/\s*curRate\(\)/.test(script), 'Source USD display rounding or conversion changed; review before syncing');
  return rate;
}

async function fetchSourceUsdRate({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const homeBytes = await requestBytes(new URL(SOURCE_URL), { fetchImpl, maxBytes: 1024 * 1024 });
  const html = homeBytes.toString('utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(match => new URL(match[1], SOURCE_URL));
  const scriptUrl = scripts.find(url => url.protocol === 'https:' && url.hostname === 'wh.suusha.com' && url.pathname === '/assets/app.js' && !url.username && !url.password && (!url.port || url.port === '443'));
  assert(scriptUrl, 'Source homepage does not expose its expected public currency script');
  const scriptBytes = await requestBytes(scriptUrl, { fetchImpl, maxBytes: 1024 * 1024 });
  return { usdDivisor: sourceUsdDivisor(scriptBytes.toString('utf8')), scriptUrl: scriptUrl.href, scriptSha256: hash(scriptBytes), scriptBytes, homeBytes, homepageSha256: hash(homeBytes), capturedAt: now().toISOString(), conversionPolicy: 'source-site-display-two-decimal-rounding' };
}

function sourceDisplayUsd(lkr, rate) {
  assert(Number.isFinite(lkr) && lkr >= 0 && Number.isFinite(rate) && rate > 0, 'Invalid source money conversion');
  return Number(new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(lkr / rate));
}

function validateMappings(map) {
  assert(map?.schemaVersion === 1 && Array.isArray(map.mappings) && map.mappings.length > 0, 'Invalid or empty explicit store/source mapping');
  assert(new Set(map.mappings.map(row => row.storeSku)).size === map.mappings.length, 'Duplicate managed store SKU mappings');
  for (const row of map.mappings) {
    assert(row.priceBasis === 'site-resale-display' && /^L\d{3,8}$/.test(row.sourceId || ''), 'Unsupported managed source price policy');
    assert(typeof row.sourceVariantSku === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(row.sourceVariantSku), 'Supplier API requires an explicit exact source variant SKU');
    const anchor = `SHUSHA-${row.sourceId}`;
    const isAnchor = row.storeSku === anchor;
    assert(isAnchor || row.storeSku === `${anchor}-V-${row.sourceVariantSku}`, 'Managed mapping is outside the store namespace');
    assert(row.storeUrlKey === (isAnchor ? row.sourceId.toLowerCase() : `${row.sourceId.toLowerCase()}-v-${row.sourceVariantSku.toLowerCase()}`), 'Managed source mapping SKU and public URL differ');
  }
  return map.mappings;
}

function planMappedPrices(map, feed, rate) {
  const mappings = validateMappings(map);
  assert(feed.currency === 'LKR' && feed.priceField === PRICE_FIELD, 'Supplier API currency or price basis differs');
  assert(Number.isFinite(rate.usdDivisor) && rate.usdDivisor > 0, 'Source USD display rate missing');
  return mappings.map(mapping => {
    const row = feed.bySku.get(mapping.sourceVariantSku);
    let skipReason = null;
    if (!row) skipReason = 'supplier-source-sku-missing';
    else if (row.ambiguous) skipReason = 'supplier-source-sku-ambiguous';
    else if (row.lkr === null || row.lkr <= 0) skipReason = 'supplier-source-price-missing-or-invalid';
    else if (row.stockQty === null) skipReason = 'supplier-source-stock-invalid';
    else if (row.stockQty <= 0) skipReason = 'supplier-source-variant-unavailable';
    const price = skipReason ? null : sourceDisplayUsd(row.lkr, rate.usdDivisor);
    if (!skipReason && price <= 0) skipReason = 'supplier-source-usd-price-zero';
    return { ...mapping, sourcePriceLkr: row?.lkr ?? null, sourcePriceUsd: skipReason ? null : price, sourceStockQty: row?.stockQty ?? null, sourceCapturedAt: feed.capturedAt, sourceUsdDivisor: rate.usdDivisor, sourceApiSha256: feed.sha256, sourceRateSha256: rate.scriptSha256, skipReason };
  });
}

module.exports = { API_URL, PRICE_FIELD, redactError, parsePriceRows, fetchSupplierPrices, sourceUsdDivisor, fetchSourceUsdRate, sourceDisplayUsd, validateMappings, planMappedPrices };
