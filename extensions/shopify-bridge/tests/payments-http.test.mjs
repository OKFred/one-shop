import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createCustomerPaymentAccess } from '../src/services/customerAccess.js';
import { privateReceivingDetails } from '../src/services/payments.js';
import { createReceivingProvider, createPaymentRuntime } from '../src/services/paymentRuntime.js';
import { paymentJsonBody, createCustomerPaymentHandler, createCustomerPaymentPage, createAdminPaymentHandler, createPaymentAccessLimiter } from '../src/services/paymentHttp.js';
import { parseFromFile } from '../../../packages/evershop/dist/lib/middleware/parseFromFile.js';
import { sortMiddlewares } from '../../../packages/evershop/dist/lib/middleware/sort.js';
import { buildMiddlewareFunction } from '../../../packages/evershop/dist/lib/middleware/buildMiddlewareFunction.js';

const shop = 'synthetic-route.myshopify.com';
const appUrl = 'https://synthetic-app.example';
const appSecret = 'synthetic-application-secret-at-least-sixteen';
const accessSecret = 'synthetic-distinct-payment-secret-at-least-thirty-two';
const clientId = 'synthetic-app-client';
const orderId = 'gid://shopify/Order/1001';
const customerId = 'gid://shopify/Customer/2001';
const receiving = { verified: true, bankDetails: [{ label: 'Synthetic beneficiary', value: 'SYNTHETIC <script>never execute</script>' }], wiseBusinessOpenLink: 'https://wise.com/pay/business/synthetic-fixture' };
const bag = amount => ({ shopMoney: { amount, currencyCode: 'USD' }, presentmentMoney: { amount, currencyCode: 'USD' } });
function fixture() {
  const now = Date.now(); const epoch = Math.floor(now / 1000);
  const order = { id: orderId, legacyResourceId: '1001', customer: { id: customerId }, cancelledAt: null, closed: false, currencyCode: 'USD', presentmentCurrencyCode: 'USD', displayFinancialStatus: 'PENDING', canMarkAsPaid: true, capturable: false, paymentGatewayNames: ['Bank Deposit'], transactions: [],
    currentTotalPriceSet: bag('12.34'), currentSubtotalPriceSet: bag('10.00'), currentShippingPriceSet: bag('2.34'), currentTotalTaxSet: bag('0.00'), currentTotalDiscountsSet: bag('0.00'), totalOutstandingSet: bag('12.34'), totalReceivedSet: bag('0.00') };
  const quote = { shop, orderId, revision: 1, paymentVersion: 2, status: 'confirmed', currency: 'USD', amount: '12.34', remainingAmount: '12.34', receivedAmount: '0.00', reference: 'SHUSHA-S-1001',
    nativeMoney: { currency: 'USD', total: '12.34', subtotal: '10.00', shipping: '2.34', tax: '0.00', discounts: '0.00', outstanding: '12.34', receivedNative: '0.00' }, receivingConfig: receiving,
    ...privateReceivingDetails(receiving, { amount: '12.34', reference: 'SHUSHA-S-1001' }) };
  let blocked = false; let reads = 0;
  const repository = { async withOrderLock(id, work) { assert.equal(id, orderId); return work(); }, async getQuote() { return quote; }, async assertOrderOperable() { if (blocked) throw new Error('Synthetic canonical cancellation'); } };
  const client = { async request() { reads++; return { shop: { myshopifyDomain: shop }, order }; } };
  const customerAccess = createCustomerPaymentAccess({ shop, client, repository, appSecret, clientId, accessSecret, appUrl, allowedManualGateways: ['Bank Deposit'], now: () => now });
  function session(fields = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ aud: clientId, dest: shop, sub: customerId, iat: epoch, nbf: epoch, exp: epoch + 300, ...fields })).toString('base64url');
    return `${header}.${body}.${createHmac('sha256', appSecret).update(`${header}.${body}`).digest('base64url')}`;
  }
  return { quote, order, session, customerAccess, runtime: { config: { shop, appUrl }, customerAccess }, get reads() { return reads; }, block() { blocked = true; } };
}
async function server(work, runtime) {
  const app = express();
  const getRuntime = typeof runtime === 'function' ? runtime : async () => runtime;
  app.options('/api/shopify/payment-access', paymentJsonBody({ customer: true }));
  app.post('/api/shopify/payment-access', paymentJsonBody({ customer: true }), createCustomerPaymentHandler({ getRuntime }));
  app.get('/shopify/payment', createCustomerPaymentPage({ getRuntime }));
  app.post('/api/shopify/payment-operation', (request, response, next) => { request.getCurrentUser = () => request.get('X-Synthetic-Admin') === 'yes' ? { uuid: 'synthetic-admin' } : null; next(); }, paymentJsonBody(), createAdminPaymentHandler({ getRuntime }));
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  try { await work(`http://127.0.0.1:${listener.address().port}`); }
  finally { await new Promise(resolve => listener.close(resolve)); }
}
const request = (url, token, body, headers = {}) => fetch(`${url}/api/shopify/payment-access`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });

test('customer route requires signed ownership, ignores cookies, supports sandbox CORS and never returns bank fields', async () => {
  const state = fixture();
  await server(async url => {
    const preflight = await fetch(`${url}/api/shopify/payment-access`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*'); assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    const missing = await request(url, null, { orderId }, { Cookie: 'synthetic-admin=yes' });
    assert.equal(missing.status, 401); assert.match(missing.headers.get('cache-control'), /no-store/);
    const foreign = await request(url, state.session({ sub: 'gid://shopify/Customer/2999' }), { orderId });
    assert.equal(foreign.status, 403);
    const expired = await request(url, state.session({ iat: 1, nbf: 1, exp: 2 }), { orderId }); assert.equal(expired.status, 403);
    const forged = await request(url, state.session().slice(0, -1) + 'x', { orderId }); assert.equal(forged.status, 403);
    const spoof = await request(url, state.session(), { orderId, customerId }); assert.equal(spoof.status, 400);
    const valid = await request(url, state.session(), { orderId }, { Origin: 'null' });
    assert.equal(valid.status, 200); assert.equal(valid.headers.get('access-control-allow-origin'), '*');
    assert.equal(valid.headers.get('referrer-policy'), 'no-referrer');
    const text = await valid.text(); assert.equal(text.includes(receiving.bankDetails[0].value), false); assert.equal(text.includes('bankDetails'), false);
    const data = JSON.parse(text).data; assert.ok(data.paymentUrl.startsWith(`${appUrl}/shopify/payment?access=`));
  }, state.runtime);
});

test('customer payment page rechecks quote versions/states, escapes private fields and renders offline visible Wise control', async () => {
  const state = fixture();
  await server(async url => {
    const issued = (await (await request(url, state.session(), { orderId })).json()).data;
    const access = new URL(issued.paymentUrl).search;
    const page = await fetch(`${url}/shopify/payment${access}`); assert.equal(page.status, 200);
    assert.match(page.headers.get('cache-control'), /no-store/); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await page.text(); assert.match(html, /class="wise"/); assert.match(html, /<svg/); assert.match(html, /Pay with Wise/); assert.match(html, /min-height:48px/); assert.match(html, /background:#303e2c/); assert.match(html, /focus-visible/); assert.match(html, /@media\(max-width:480px\)/);
    assert.equal(html.includes('<script>'), false); assert.match(html, /&lt;script&gt;never execute&lt;\/script&gt;/); assert.equal(/<(?:script|img|link)\b/.test(html), false);
    assert.equal(html.includes('Shipping is not included'), false);
    state.quote.paymentVersion++;
    const obsolete = await fetch(`${url}/shopify/payment${access}`); assert.equal(obsolete.status, 403);
    const unavailableHtml = await obsolete.text(); assert.equal(unavailableHtml.includes('Pay with Wise'), false);
    assert.match(unavailableHtml, /No payable confirmed balance is currently available/);
    assert.equal(unavailableHtml.includes('after our team confirms'), false);
    for (const status of ['inactive', 'received', 'paid']) {
      state.quote.status = status;
      assert.equal((await request(url, state.session(), { orderId })).status, 403);
      const rejectedPage = await fetch(`${url}/shopify/payment${access}`);
      assert.equal(rejectedPage.status, 403); assert.match(await rejectedPage.text(), /No payable confirmed balance is currently available/);
    }
    state.quote.status = 'partial'; state.quote.remainingAmount = '7.34'; state.quote.receivedAmount = '5.00';
    Object.assign(state.quote, privateReceivingDetails(receiving, { amount: '7.34', reference: state.quote.reference }));
    const partial = (await (await request(url, state.session(), { orderId })).json()).data;
    const partialPage = await fetch(`${url}/shopify/payment${new URL(partial.paymentUrl).search}`);
    assert.equal(partialPage.status, 200); assert.match(await partialPage.text(), /Remaining amount to pay/);
    state.block(); assert.equal((await request(url, state.session(), { orderId })).status, 403);
    assert.equal((await fetch(`${url}/shopify/payment${new URL(partial.paymentUrl).search}`)).status, 403);
  }, state.runtime);
});

test('admin mutation requires merchant identity/same origin, checks cancellation under lock and sanitizes responses/errors', async () => {
  const state = fixture(); const calls = []; let blocked = false;
  const runtime = { ...state.runtime, repository: { async withOrderLock(id, work) { calls.push('lock'); const value = await work(); calls.push('unlock'); return value; }, async assertOrderOperable() { calls.push('guard'); if (blocked) throw new Error('Synthetic receipt account number must not leak'); } },
    payments: { async confirmShippingQuote(input) { calls.push('quote'); assert.equal(input.merchantAvailabilityConfirmed, true); return { quote: state.quote, nativeVerified: true, customerNotified: false, privateReceivingConfig: receiving }; } },
    fulfillment: {}, async inspect() { return { quote: { revision: 1 }, receipts: { count: 0, receivedAmount: '0.00' }, nativeOrder: { id: orderId } }; } };
  await server(async url => {
    const post = (headers = {}, input = { orderId, merchantAvailabilityConfirmed: true }) => fetch(`${url}/api/shopify/payment-operation`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action: 'confirm-quote', input }) });
    assert.equal((await post({ Origin: appUrl })).status, 401);
    assert.equal((await post({ Origin: 'https://foreign.example', 'X-Synthetic-Admin': 'yes' })).status, 403);
    const accepted = await post({ Origin: appUrl, 'X-Synthetic-Admin': 'yes' }); assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), null); assert.match(accepted.headers.get('cache-control'), /no-store/);
    const data = await accepted.json(); assert.equal(data.data.quote.bankDetails, undefined); assert.equal(data.data.privateReceivingConfig, undefined); assert.deepEqual(calls, ['lock', 'guard', 'quote', 'unlock']);
    blocked = true;
    const denied = await post({ Origin: appUrl, 'X-Synthetic-Admin': 'yes' }); assert.equal(denied.status, 409);
    assert.equal((await denied.text()).includes('account number'), false); assert.equal(calls.filter(value => value === 'quote').length, 1);
  }, runtime);
});

test('verified native receiving adapter requires approved USD fields and never substitutes public placeholders/GBP', async () => {
  const absent = createReceivingProvider(() => ({ openLink: receiving.wiseBusinessOpenLink, accounts: { GBP: { fields: receiving.bankDetails } } }));
  await assert.rejects(absent(), /Verified USD/);
  const approved = createReceivingProvider(() => ({ openLink: receiving.wiseBusinessOpenLink, accounts: { USD: { fields: receiving.bankDetails } } }));
  assert.deepEqual(await approved(), receiving);
});

test('disabled bridge payment inspection and customer paths return only generic unavailable responses without configuration reads', async () => {
  let receivingReads = 0;
  const getRuntime = async () => createPaymentRuntime({ runtime: { config: { enabled: false } }, receivingLoader: () => { receivingReads++; throw new Error('Private receiving config must never be read'); } });
  await server(async url => {
    const customer = await request(url, 'e30.e30.syntheticSignature', { orderId });
    assert.equal(customer.status, 503); assert.match(customer.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await customer.json(), { error: { code: 'PAYMENT_ACCESS_UNAVAILABLE' } });
    const inspection = await fetch(`${url}/api/shopify/payment-operation`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: appUrl, 'X-Synthetic-Admin': 'yes' }, body: JSON.stringify({ action: 'inspect', input: { orderId } }) });
    assert.equal(inspection.status, 409); const body = await inspection.json();
    assert.equal(body.error.code, 'SHOPIFY_PAYMENT_OPERATION_REVIEW'); assert.equal(body.data, undefined);
    assert.equal(JSON.stringify(body).includes('receiving'), false);
    const page = await fetch(`${url}/shopify/payment?access=synthetic-expired-entry`);
    assert.equal(page.status, 403); const html = await page.text();
    assert.match(html, /No payable confirmed balance is currently available/); assert.equal(html.includes('Pay with Wise'), false);
    assert.equal(receivingReads, 0);
  }, getRuntime);
});

test('runtime gates actual writes independently, keeps receiving files lazy and returns a bounded private inspection', async () => {
  const state = fixture(); let receivingReads = 0; let cancelIntent = null;
  const pool = { async connect() { throw new Error('Unexpected write transaction'); }, async query(sql) { return { rows: sql.includes('FROM shusha_bridge_payment_quote') ? [{ record: state.quote }] : [] }; } };
  const runtime = { config: { enabled: true, writesEnabled: true, shop, appUrl, clientId, clientSecret: appSecret }, pool,
    repositories: { mappings: { async getOperation(key) { assert.equal(key, `order-restock:${orderId}`); return cancelIntent; } } },
    client: { async request() { return { shop: { myshopifyDomain: shop }, order: { ...state.order, fulfillmentOrders: { nodes: [], pageInfo: { hasNextPage: false } }, fulfillments: [] } }; } } };
  const disabled = createPaymentRuntime({ runtime, env: {}, receivingLoader: () => { receivingReads++; return {}; } });
  assert.equal(disabled.customerAccess, null); assert.equal(disabled.writesEnabled, false);
  await assert.rejects(disabled.payments.confirmShippingQuote({}), /writes are disabled/);
  const inspected = await disabled.inspect(orderId);
  assert.equal(inspected.cancellation, null);
  assert.equal(inspected.quote.revision, 1); assert.equal(inspected.quote.bankDetails, undefined); assert.equal(inspected.quote.wisePaymentUrl, undefined);
  assert.equal(JSON.stringify(inspected).includes(receiving.bankDetails[0].value), false); assert.equal(receivingReads, 0);
  cancelIntent = { kind: 'order-cancel', shop, orderId, status: 'unknown', operationKey: 'synthetic-cancel-operation-1', input: { reason: 'CUSTOMER' }, before: { privateCustomer: 'SYNTHETIC-PRIVATE-NEVER-RETURN' } };
  const recovery = await disabled.inspect(orderId);
  assert.deepEqual(recovery.cancellation, { status: 'unknown', operationKey: 'synthetic-cancel-operation-1', reason: 'CUSTOMER' });
  assert.equal(JSON.stringify(recovery).includes('SYNTHETIC-PRIVATE-NEVER-RETURN'), false);
  cancelIntent.shop = 'synthetic-other-shop.myshopify.com'; await assert.rejects(disabled.inspect(orderId), /identity review/); cancelIntent = null;
  const approvedEnv = { SHOPIFY_PAYMENT_OPERATIONS_ENABLED: 'true', SHOPIFY_MANUAL_GATEWAYS: '["Bank Deposit"]', SHOPIFY_FULFILLMENT_LOCATION_IDS: '["gid://shopify/Location/1"]', SHOPIFY_PAYMENT_ACCESS_SECRET: accessSecret };
  const readOnly = createPaymentRuntime({ runtime: { ...runtime, config: { ...runtime.config, writesEnabled: false } }, env: approvedEnv, receivingLoader: () => ({ accounts: { USD: { fields: receiving.bankDetails } } }) });
  assert.ok(readOnly.customerAccess); assert.equal(readOnly.writesEnabled, false);
  await assert.rejects(readOnly.payments.confirmShippingQuote({}), /writes are disabled/);
  assert.throws(() => createPaymentRuntime({ runtime, env: { ...approvedEnv, SHOPIFY_MANUAL_GATEWAYS: 'Bank Deposit' }, receivingLoader: () => ({}) }), /reviewed JSON list/);
});

test('customer access throttles repeated credentials/addresses, bounds memory and expires windows without storing raw credentials', () => {
  let clock = 1;
  const allow = createPaymentAccessLimiter({ now: () => clock, windowMs: 100, perToken: 2, perAddress: 3, maxEntries: 4 });
  assert.equal(allow({ token: 'synthetic-a', address: 'synthetic-origin-1' }), true);
  assert.equal(allow({ token: 'synthetic-a', address: 'synthetic-origin-1' }), true);
  assert.equal(allow({ token: 'synthetic-a', address: 'synthetic-origin-1' }), false);
  assert.equal(allow({ token: 'synthetic-b', address: 'synthetic-origin-1' }), true);
  assert.equal(allow({ token: 'synthetic-c', address: 'synthetic-origin-1' }), false);
  assert.equal(allow({ token: 'synthetic-new', address: 'synthetic-origin-2' }), false);
  clock = 102;
  assert.equal(allow({ token: 'synthetic-a', address: 'synthetic-origin-1' }), true);
});

test('native routing keeps merchant operations private and customer HTML outside GraphQL response rendering', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const adminRoute = JSON.parse(await fs.readFile(path.join(root, 'api/shopifyPaymentOperation/route.json'), 'utf8'));
  assert.equal(adminRoute.access, 'private'); assert.deepEqual(adminRoute.methods, ['POST']);
  const customerRoute = JSON.parse(await fs.readFile(path.join(root, 'api/shopifyPaymentAccess/route.json'), 'utf8'));
  assert.equal(customerRoute.access, 'public'); assert.deepEqual(customerRoute.methods, ['POST', 'OPTIONS']);
  const admin = parseFromFile(path.join(root, 'api/shopifyPaymentOperation/[auth]operation[apiResponse].js'))[0];
  const page = parseFromFile(path.join(root, 'pages/frontStore/shopifyPayment/[context]payment[response].js'))[0];
  const globals = ['context', 'getCurrentUser', 'auth', 'apiResponse'].map(id => ({ id, scope: 'app', region: 'api', routeId: null }));
  const sorted = sortMiddlewares([...globals, admin]);
  assert.ok(sorted.findIndex(value => value.id === 'auth') < sorted.findIndex(value => value.id === 'operation'));
  assert.ok(page.after.includes('context')); assert.ok(page.before.includes('response'));
});

test('actual native wrapper terminates the redeemed HTML response before the default renderer', async () => {
  const state = fixture(); const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-payment-wrapper-')); let advanced = false;
  const helper = new URL('../src/services/paymentHttp.js', import.meta.url).href;
  const modulePath = path.join(temp, 'payment.mjs');
  await fs.writeFile(modulePath, `import {createCustomerPaymentPage} from ${JSON.stringify(helper)};\nexport default createCustomerPaymentPage({getRuntime:async()=>({config:{shop:${JSON.stringify(shop)}},customerAccess:{redeem:async()=>(${JSON.stringify({ quote: { status: state.quote.status, revision: 1, currency: 'USD', amount: '12.34', reference: state.quote.reference, wisePaymentUrl: state.quote.wisePaymentUrl, bankDetails: state.quote.bankDetails }, expiresAt: Date.now() + 300000 })})}})});\n`);
  const app = express();
  app.get('/shopify/payment', (request, response, next) => { response.debugMiddlewares = []; next(); }, buildMiddlewareFunction('payment', modulePath), (request, response) => { advanced = true; response.end('wrong renderer'); });
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/shopify/payment?access=synthetic-signed-entry`);
    assert.equal(response.status, 200); assert.match(await response.text(), /Pay with Wise/); assert.equal(advanced, false);
    assert.equal(createCustomerPaymentHandler({ getRuntime: () => {} }).length, 3);
    assert.equal(createAdminPaymentHandler({ getRuntime: () => {} }).length, 3);
  } finally {
    await new Promise(resolve => listener.close(resolve));
    const resolved = path.resolve(temp), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('shusha-payment-wrapper-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
