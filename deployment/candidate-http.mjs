#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Read-only candidate acceptance. Never auto-loads .env or submits a mutation.
const CATEGORIES = ['/dresses', '/pants', '/tops'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class AcceptanceError extends Error {}
const check = (ok, code) => { if (!ok) throw new AcceptanceError(code); };

export function parseOptions(argv = [], env = process.env) {
  const options = {
    origin: env.SHUSHA_HTTP_ORIGIN || 'http://127.0.0.1:5444',
    database: env.SHUSHA_HTTP_USE_DB === '1',
    requirePayment: env.SHUSHA_HTTP_REQUIRE_PAYMENT === '1',
    orderUuid: env.SHUSHA_TEST_ORDER_UUID,
    quoteStatus: env.SHUSHA_TEST_QUOTE_STATUS,
    quoteCurrency: env.SHUSHA_TEST_QUOTE_CURRENCY,
    quoteAmount: env.SHUSHA_TEST_QUOTE_AMOUNT,
    products: env.SHUSHA_TEST_PRODUCTS ? JSON.parse(env.SHUSHA_TEST_PRODUCTS) : [],
    legacy: env.SHUSHA_TEST_LEGACY_PATHS ? JSON.parse(env.SHUSHA_TEST_LEGACY_PATHS) : []
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--origin') { check(argv[index + 1], 'origin-argument-required'); options.origin = argv[++index]; }
    else if (argument === '--database') options.database = true;
    else if (argument === '--require-payment') options.requirePayment = true;
    else if (argument === '--help') options.help = true;
    else throw new AcceptanceError('unknown-argument');
  }
  if (options.help) return options;
  const origin = new URL(options.origin);
  check(['http:', 'https:'].includes(origin.protocol) && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'candidate-origin-must-be-loopback');
  options.origin = origin.origin;
  check(!options.orderUuid || UUID.test(options.orderUuid), 'invalid-test-order-uuid');
  check(!options.requirePayment || options.orderUuid, 'test-order-uuid-required');
  check(!options.quoteStatus || ['confirmed', 'paid'].includes(options.quoteStatus), 'invalid-quote-status');
  check(!options.quoteCurrency || /^[A-Z]{3}$/.test(options.quoteCurrency), 'invalid-quote-currency');
  check(!options.quoteAmount || /^\d+\.\d{2}$/.test(options.quoteAmount), 'invalid-quote-amount');
  check(Array.isArray(options.products) && Array.isArray(options.legacy), 'invalid-path-array');
  options.products = options.products.map(item => typeof item === 'string' ? { path: item } : item);
  check(options.products.every(item => isProductPath(item?.path) && (!item.uuid || UUID.test(item.uuid))), 'invalid-product-path');
  check(options.legacy.every(item => isLocalPath(item?.requestPath) && isCatalogPath(item.targetPath) && item.requestPath !== item.targetPath), 'invalid-legacy-path');
  return options;
}

const isLocalPath = value => typeof value === 'string' && /^\/(?!\/)[^\s\\?#\u0000-\u001f\u007f]+$/.test(value);
const isProductPath = value => typeof value === 'string' && /^\/(?:dresses|pants|tops)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const isCatalogPath = value => CATEGORIES.includes(value) || isProductPath(value);
const htmlBody = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
const textContent = html => htmlBody(html).replace(/<[^>]+>/g, ' ').replace(/&(?:amp|#38);/g, '&').replace(/\s+/g, ' ');
const attributeValue = value => value.replace(/&amp;/g, '&');

export function pageContext(html) {
  const match = /<script\b[^>]*>\s*var\s+eContext\s*=\s*([\s\S]*?)<\/script>/i.exec(html);
  check(match, 'ssr-context-missing');
  // JSON only: never execute the server's script text.
  try { return JSON.parse(match[1].trim().replace(/;$/, '')); }
  catch { throw new AcceptanceError('ssr-context-invalid'); }
}

function findObjects(value, predicate, result = []) {
  if (value && typeof value === 'object') {
    if (predicate(value)) result.push(value);
    for (const child of Object.values(value)) findObjects(child, predicate, result);
  }
  return result;
}

export function hasOfflineIcons(html) {
  const svgs = [...htmlBody(html).matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)].map(match => match[0]);
  return ['M6.488 7.469', 'M17.472 14.382'].every(signature => svgs.some(svg => svg.includes(signature) && /aria-hidden="true"/.test(svg) && /focusable="false"/.test(svg) && /<path\b/.test(svg)));
}

async function readCatalog(options, env) {
  check(/(?:^|[_-])(?:test|candidate|integration)(?:[_-]|$)/i.test(env.DB_NAME || ''), 'read-only-catalog-requires-isolated-database');
  const { createDatabasePool } = await import('./capture-baseline.mjs');
  const pool = await createDatabasePool(env);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL statement_timeout=10000');
    const products = (await client.query(`SELECT r.request_path AS path,p.uuid FROM url_rewrite r JOIN product p ON p.uuid=r.entity_uuid WHERE r.entity_type='product' AND p.status IS TRUE AND p.visibility IS TRUE AND p.sku ~ '^SHUSHA-L[0-9]+$' ORDER BY r.request_path`)).rows;
    check(products.length > 0 && products.every(item => isProductPath(item.path) && UUID.test(item.uuid)), 'mapped-catalog-empty-or-invalid');
    const exists = (await client.query("SELECT to_regclass('public.shusha_legacy_path') AS ledger")).rows[0].ledger;
    const legacy = exists ? (await client.query('SELECT request_path AS "requestPath",target_path AS "targetPath" FROM shusha_legacy_path ORDER BY request_path')).rows : [];
    check(legacy.every(item => isLocalPath(item.requestPath) && isCatalogPath(item.targetPath) && item.requestPath !== item.targetPath), 'legacy-catalog-invalid');
    if (options.orderUuid) {
      const order = (await client.query('SELECT uuid,payment_method FROM "order" WHERE uuid=$1', [options.orderUuid])).rows[0];
      check(order?.payment_method === 'banktransfer', 'test-bank-order-unavailable');
    }
    await client.query('COMMIT');
    return { products, legacy };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); await pool.end(); }
}

export async function verifyHttp(options, { fetchImpl = fetch, env = process.env } = {}) {
  let checks = 0;
  const counts = { categories: 0, products: 0, productIdentities: 0, legacyRedirects: 0, assets: 0 };
  const assertion = (ok, code) => { check(ok, code); checks++; };
  const request = async (requestPath, init = {}) => {
    const url = new URL(requestPath, options.origin);
    check(url.origin === options.origin, 'external-request-blocked');
    return fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'SHUSHA-Candidate-Read-Only/1.0', 'Cache-Control': 'no-cache', ...init.headers } });
  };
  const page = async (requestPath, code) => {
    const response = await request(requestPath);
    assertion(response.status === 200, `${code}-http-status`);
    assertion((response.headers.get('content-type') || '').includes('text/html'), `${code}-content-type`);
    return { response, html: await response.text() };
  };
  const home = await page('/', 'homepage');
  const homeVisible = htmlBody(home.html);
  assertion(/SHUSHA/.test(textContent(home.html)), 'homepage-brand');
  assertion(/<section\b[^>]*class="[^"]*\bshusha-hero\b/.test(homeVisible), 'homepage-hero');
  assertion(/<h1\b/.test(homeVisible), 'homepage-hero-heading');
  assertion(CATEGORIES.every(category => new RegExp(`<a\\b[^>]*href="${category}"`).test(homeVisible)), 'homepage-category-menu');
  assertion(hasOfflineIcons(home.html), 'homepage-offline-brand-svg');
  assertion(/WhatsApp/.test(textContent(home.html)) && /Wise/.test(textContent(home.html)), 'homepage-visible-icon-labels');
  const logoPath = '/assets/shusha/shusha-wordmark.svg';
  const imagePaths = [...homeVisible.matchAll(/<img\b[^>]*src="([^"]+)"/gi)].map(match => attributeValue(match[1]));
  assertion(imagePaths.some(source => {
    const url = new URL(source, options.origin);
    return url.origin === options.origin && (url.pathname === logoPath || url.pathname === '/images' && url.searchParams.get('src') === logoPath);
  }), 'homepage-logo-reference');
  const logo = await request(logoPath);
  assertion(logo.status === 200 && (logo.headers.get('content-type') || '').includes('image/svg+xml'), 'logo-http-status');
  const logoText = await logo.text();
  assertion(/<svg\b/.test(logoText) && /SHUSHA/.test(logoText), 'logo-svg-brand'); counts.assets++;
  for (const category of CATEGORIES) {
    const item = await page(category, 'category');
    assertion(/<h1\b/.test(htmlBody(item.html)), 'category-heading'); counts.categories++;
  }
  const db = options.database ? await readCatalog(options, env) : { products: [], legacy: [] };
  const products = [...new Map([...db.products, ...options.products].map(item => [item.path, item])).values()];
  const legacy = [...new Map([...db.legacy, ...options.legacy].map(item => [item.requestPath, item])).values()];
  for (const product of products) {
    const item = await page(product.path, 'product');
    assertion(/<h1\b/.test(htmlBody(item.html)), 'product-heading');
    if (product.uuid) {
      const context = pageContext(item.html);
      assertion(findObjects(context.graphqlResponse, value => value.uuid?.toLowerCase() === product.uuid.toLowerCase()).length > 0, 'mapped-product-identity'); counts.productIdentities++;
      await page(`/product/${product.uuid}`, 'product-uuid');
    }
    counts.products++;
  }
  const suffix = '?shusha_readonly_check=1&empty=&duplicate=one&duplicate=two';
  for (const redirect of legacy) {
    const response = await request(redirect.requestPath + suffix);
    assertion(response.status === 301, 'legacy-redirect-status');
    const location = new URL(response.headers.get('location') || '', options.origin);
    assertion(location.origin === options.origin && location.pathname === redirect.targetPath && location.search === suffix, 'legacy-redirect-target-and-query');
    await response.body?.cancel(); counts.legacyRedirects++;
  }
  // Only request local assets; never fetch Wise, WhatsApp or any other provider.
  const allScripts = [...home.html.matchAll(/<script\b[^>]*src="([^"]+)"/gi)].map(match => attributeValue(match[1]));
  const assets = [...new Set([...allScripts, ...imagePaths])].filter(value => value.startsWith('/') && !value.startsWith('//') && value !== logoPath);
  assertion(allScripts.some(value => value.startsWith('/') && /\.js(?:\?|$)/.test(value)), 'homepage-client-bundle');
  for (const asset of assets) {
    const response = await request(asset);
    assertion(response.status === 200, 'local-asset-http-status'); await response.body?.cancel(); counts.assets++;
  }
  const gql = async (query, variables = {}) => {
    const response = await request('/api/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
    assertion(response.status === 200, 'graphql-http-status');
    assertion(/\bno-store\b/.test(response.headers.get('cache-control') || ''), 'graphql-no-store');
    const value = await response.json();
    assertion(!value.errors && !value.error && value.data, 'graphql-response'); return value.data;
  };
  const types = await gql('{ guest:__type(name:"BankTransferPaymentOrder"){fields{name}} setting:__type(name:"Setting"){fields{name}} __schema{queryType{fields{name}}} bankTransferPaymentOrder{orderNumber} bankTransferCustomerPayments{orderNumber} }');
  assertion(types.bankTransferPaymentOrder === null && types.bankTransferCustomerPayments.length === 0, 'anonymous-payment-context-isolated');
  assertion(types.guest && types.guest.fields.every(field => ['orderNumber', 'paymentMethod', 'bankTransferQuote', 'bankTransferPaymentUrl'].includes(field.name)), 'guest-schema-has-no-customer-fields');
  assertion(types.setting && types.setting.fields.filter(field => field.name.startsWith('bankTransfer')).every(field => ['bankTransferPaymentStatus', 'bankTransferDisplayName', 'bankTransferContactSriLanka', 'bankTransferContactChina'].includes(field.name)), 'public-settings-have-no-bank-account-details');
  assertion(!types.__schema.queryType.fields.some(field => field.name === 'bankTransferReceivingConfig'), 'receiving-config-is-admin-only');
  let payment = false;
  if (options.orderUuid) {
    const result = await page(`/payment/${options.orderUuid}`, 'payment');
    assertion(/\bno-store\b/.test(result.response.headers.get('cache-control') || ''), 'payment-no-store');
    assertion(/\bnoindex\b/.test(result.response.headers.get('x-robots-tag') || ''), 'payment-noindex');
    assertion(result.response.headers.get('referrer-policy') === 'no-referrer', 'payment-no-referrer');
    const context = pageContext(result.html);
    const orders = findObjects(context.graphqlResponse, value => value.paymentMethod === 'banktransfer' && Object.hasOwn(value, 'bankTransferQuote'));
    assertion(orders.length === 1, 'payment-restricted-guest-order');
    const order = orders[0];
    assertion(Object.keys(order).every(key => ['orderNumber', 'paymentMethod', 'bankTransferQuote', 'bankTransferPaymentUrl'].includes(key)), 'payment-guest-response-has-no-customer-identity');
    assertion(order.bankTransferQuote && ['confirmed', 'paid'].includes(order.bankTransferQuote.status), 'payment-confirmed-or-paid-quote');
    for (const [property, expected] of [['status', options.quoteStatus], ['currency', options.quoteCurrency], ['amount', options.quoteAmount]]) {
      if (expected !== undefined) assertion(order.bankTransferQuote[property] === expected, `payment-expected-${property}`);
    }
    assertion(hasOfflineIcons(result.html), 'payment-offline-brand-svg');
    const wiseLinks = [...htmlBody(result.html).matchAll(/<a\b([^>]*href="https:\/\/wise\.com\/[^"]+"[^>]*)>/gi)];
    if (order.bankTransferQuote.status === 'confirmed' && order.bankTransferQuote.wisePaymentUrl) {
      assertion(wiseLinks.length > 0 && wiseLinks.every(match => /rel="[^"]*\bnoreferrer\b/.test(match[1])), 'wise-link-noreferrer');
      assertion(/Pay with Wise/.test(textContent(result.html)), 'wise-visible-payment-action');
    }
    const denied = await gql('query($uuid:String!){order(uuid:$uuid){orderNumber customerEmail shippingAddress{fullName}} bankTransferCustomerPaymentOrder(uuid:$uuid){orderNumber}}', { uuid: options.orderUuid });
    assertion(denied.order === null && denied.bankTransferCustomerPaymentOrder === null, 'anonymous-order-and-pii-denied');
    payment = true;
  }
  return { passed: true, checks, counts, coverage: { homepage: true, catalog: true, mappedProductIdentity: counts.productIdentities > 0, legacyRedirects: counts.legacyRedirects > 0, offlineSvgRendered: true, publicSchemaPrivacy: true, paymentLink: payment }, skipped: [...(!products.length ? ['mapped-products'] : []), ...(!legacy.length ? ['legacy-redirects'] : []), ...(!payment ? ['payment-link'] : [])], readOnly: true, providerCalls: 0, customerMessages: 0 };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node deployment/candidate-http.mjs [--origin http://127.0.0.1:5444] [--database] [--require-payment]\nNever reads .env automatically. Supply SHUSHA_TEST_ORDER_UUID and optional SHUSHA_TEST_QUOTE_STATUS/CURRENCY/AMOUNT privately. SHUSHA_TEST_PRODUCTS is a JSON array of {path,uuid}; SHUSHA_TEST_LEGACY_PATHS is [{requestPath,targetPath}]. --database reads candidate/test DB_* in a read-only transaction to discover catalog/legacy paths. Reports counts and boolean coverage only; no order, customer, bank or source values.');
    return;
  }
  console.log(JSON.stringify(await verifyHttp(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const errorName = ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AcceptanceError'].includes(error.name) ? error.name : 'Error';
    const errorCode = /^[0-9A-Z_]{3,40}$/.test(String(error.code || error.cause?.code || '')) ? String(error.code || error.cause.code) : undefined;
    console.error(JSON.stringify({ passed: false, reason: error instanceof AcceptanceError ? error.message : 'candidate-http-acceptance-failed', errorName, ...(errorCode ? { errorCode } : {}), detailsWithheld: true, readOnly: true, providerCalls: 0, customerMessages: 0 })); process.exitCode = 1;
  });
}
