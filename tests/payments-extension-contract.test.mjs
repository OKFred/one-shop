import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import { requestPaymentEntry } from '../shopify/extensions/wise-payment/src/payment-entry.js';
import { createCustomerPaymentAccess } from '../extensions/shopify-bridge/src/services/customerAccess.js';
import { privateReceivingDetails, PAYMENT_GRAPHQL } from '../extensions/shopify-bridge/src/services/payments.js';
import { paymentJsonBody, createCustomerPaymentHandler, createCustomerPaymentPage } from '../extensions/shopify-bridge/src/services/paymentHttp.js';

// Invented identities and receiving fields only. The actual HTTP/authentication
// handlers run locally; the injected Admin client permits reads and no writes.
const SHOP = 'synthetic-extension.myshopify.com', APP = 'https://synthetic-app.example';
const ORDER = 'gid://shopify/Order/1001', CUSTOMER = 'gid://shopify/Customer/2001';
const CLIENT_ID = 'synthetic-app-client', APP_SECRET = 'synthetic-application-secret-at-least-sixteen';
const ACCESS_SECRET = 'synthetic-distinct-payment-secret-at-least-thirty-two';
const NOW = Date.parse('2026-10-10T01:02:03.456Z'), epoch = Math.floor(NOW / 1000);
const bag = amount => ({ shopMoney: { amount, currencyCode: 'USD' }, presentmentMoney: { amount, currencyCode: 'USD' } });
function fixture() {
  const receiving = { verified: true, bankDetails: [{ label: 'Synthetic beneficiary', value: 'SYNTHETIC RECEIVING FIELD' }], wiseBusinessOpenLink: 'https://wise.com/pay/business/synthetic-fixture' };
  const order = { id: ORDER, legacyResourceId: '1001', customer: { id: CUSTOMER }, cancelledAt: null, closed: false, currencyCode: 'USD', presentmentCurrencyCode: 'USD', displayFinancialStatus: 'PENDING', canMarkAsPaid: true, capturable: false, paymentGatewayNames: ['Bank Deposit'], transactions: [],
    currentTotalPriceSet: bag('12.34'), currentSubtotalPriceSet: bag('10.00'), currentShippingPriceSet: bag('2.34'), currentTotalTaxSet: bag('0.00'), currentTotalDiscountsSet: bag('0.00'), totalOutstandingSet: bag('12.34'), totalReceivedSet: bag('0.00') };
  const quote = { shop: SHOP, orderId: ORDER, revision: 1, paymentVersion: 2, status: 'confirmed', currency: 'USD', amount: '12.34', remainingAmount: '12.34', receivedAmount: '0.00', reference: 'SHUSHA-S-1001', receivingConfig: receiving,
    nativeMoney: { currency: 'USD', total: '12.34', subtotal: '10.00', shipping: '2.34', tax: '0.00', discounts: '0.00', outstanding: '12.34', receivedNative: '0.00' },
    ...privateReceivingDetails(receiving, { amount: '12.34', reference: 'SHUSHA-S-1001' }) };
  let locked = false, blocked = false, reads = 0, sessions = 0;
  const repository = {
    async withOrderLock(id, work) { assert.equal(id, ORDER); locked = true; try { return await work(); } finally { locked = false; } },
    async getQuote() { assert.equal(locked, true); return quote; },
    async assertOrderOperable() { assert.equal(locked, true); if (blocked) throw new Error('Synthetic canonical cancellation'); }
  };
  const client = { async request(document, variables) { assert.equal(document, PAYMENT_GRAPHQL.order, 'this fixture cannot mutate a provider'); assert.equal(variables.id, ORDER); assert.equal(locked, true); reads++; return { shop: { myshopifyDomain: SHOP }, order }; } };
  const customerAccess = createCustomerPaymentAccess({ shop: SHOP, client, repository, appSecret: APP_SECRET, clientId: CLIENT_ID, accessSecret: ACCESS_SECRET, appUrl: APP, allowedManualGateways: ['Bank Deposit'], now: () => NOW });
  function session(fields = {}) {
    // Official customer-account SDK claim shape: dest is the shop hostname,
    // sub is the signed-in Customer GID; sessionToken.get() is called per request.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ aud: CLIENT_ID, dest: SHOP, sub: CUSTOMER, iat: epoch, nbf: epoch, exp: epoch + 300, jti: `synthetic-sdk-session-${++sessions}`, ...fields })).toString('base64url');
    return `${header}.${body}.${createHmac('sha256', APP_SECRET).update(`${header}.${body}`).digest('base64url')}`;
  }
  return { order, quote, session, block: () => { blocked = true; }, get reads() { return reads; }, runtime: { config: { shop: SHOP, appUrl: APP }, customerAccess } };
}
async function localBackend(runtime, work) {
  const app = express();
  const getRuntime = typeof runtime === 'function' ? runtime : async () => runtime;
  app.post('/api/shopify/payment-access', paymentJsonBody({ customer: true }), createCustomerPaymentHandler({ getRuntime, allowRequest: () => true }));
  app.get('/shopify/payment', createCustomerPaymentPage({ getRuntime, allowRequest: () => true }));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  const local = `http://127.0.0.1:${listener.address().port}`;
  const fetchImpl = (url, options) => {
    assert.equal(new URL(url).origin, APP, 'extension destinations remain HTTPS and on the configured application origin');
    return fetch(`${local}${new URL(url).pathname}${new URL(url).search}`, options);
  };
  try { await work(fetchImpl); }
  finally { await new Promise(resolve => listener.close(resolve)); }
}
const entryArgs = (state, fetchImpl, extra = {}) => ({ backendOrigin: APP, orderId: ORDER, fullyAuthenticated: true, getSessionToken: async () => state.session(), fetchImpl, now: () => NOW, ...extra });

test('actual payment-access envelope enables the native helper and its signed page rechecks ownership', async () => {
  const state = fixture();
  await localBackend(state.runtime, async fetchImpl => {
    const bearers = [], payloads = [];
    const inspectFetch = async (url, options) => {
      assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { orderId: ORDER });
      bearers.push(options.headers.Authorization);
      const response = await fetchImpl(url, options);
      assert.match(response.headers.get('cache-control'), /no-store/);
      payloads.push(await response.clone().json()); return response;
    };
    const first = await requestPaymentEntry(entryArgs(state, inspectFetch));
    assert.deepEqual(Object.keys(payloads[0]), ['data']);
    assert.deepEqual(first, payloads[0].data, 'the extension consumes the real backend envelope');
    assert.equal(first.quoteRevision, 1); assert.equal(first.expiresAt, (epoch + 300) * 1000);
    assert.doesNotMatch(JSON.stringify(payloads[0]), /SYNTHETIC RECEIVING FIELD|wise\.com|bankDetails/);
    const second = await requestPaymentEntry(entryArgs(state, inspectFetch));
    assert.notEqual(bearers[0], bearers[1], 'every request obtains its session from the SDK callback');
    assert.notEqual(first.paymentUrl, second.paymentUrl, 'payment credentials are newly issued and remain in memory');
    const paymentPage = await fetchImpl(first.paymentUrl);
    assert.equal(paymentPage.status, 200); assert.match(paymentPage.headers.get('cache-control'), /no-store/);
    const html = await paymentPage.text(); assert.match(html, /Pay with Wise/); assert.match(html, /SYNTHETIC RECEIVING FIELD/);
    assert.equal(state.reads, 3, 'both issuances and redemption independently read native ownership/money');
    state.order.customer.id = 'gid://shopify/Customer/2999';
    const foreignPage = await fetchImpl(first.paymentUrl); assert.equal(foreignPage.status, 403);
    assert.doesNotMatch(await foreignPage.text(), /SYNTHETIC RECEIVING FIELD|https:\/\/wise\.com/);
  });
});

test('actual owner/session and inactive, received, paid or cancelled quote denials hide every payment entry', async () => {
  const changes = [
    state => ({ getSessionToken: async () => state.session({ sub: undefined }) }),
    state => ({ getSessionToken: async () => state.session({ sub: 'gid://shopify/Customer/2999' }) }),
    state => ({ getSessionToken: async () => state.session({ dest: 'foreign-store.myshopify.com' }) }),
    state => { state.quote.status = 'inactive'; return {}; },
    state => { state.quote.status = 'received'; state.quote.remainingAmount = '0.00'; return {}; },
    state => { state.order.displayFinancialStatus = 'PAID'; state.order.totalOutstandingSet = bag('0.00'); return {}; },
    state => { state.order.cancelledAt = '2026-10-10T01:02:03Z'; return {}; },
    state => { state.block(); return {}; }
  ];
  for (const change of changes) {
    const state = fixture(), overrides = change(state);
    await localBackend(state.runtime, async fetchImpl => assert.equal(await requestPaymentEntry(entryArgs(state, fetchImpl, overrides)), null));
  }
});

test('changed payment versions reject an existing signed entry and allow only freshly issued remaining amounts', async () => {
  const state = fixture();
  await localBackend(state.runtime, async fetchImpl => {
    const oldEntry = await requestPaymentEntry(entryArgs(state, fetchImpl));
    state.quote.status = 'partial'; state.quote.paymentVersion++; state.quote.receivedAmount = '5.00'; state.quote.remainingAmount = '7.34';
    Object.assign(state.quote, privateReceivingDetails(state.quote.receivingConfig, { amount: '7.34', reference: state.quote.reference }));
    const stalePage = await fetchImpl(oldEntry.paymentUrl); assert.equal(stalePage.status, 403); assert.doesNotMatch(await stalePage.text(), /SYNTHETIC RECEIVING FIELD/);
    const current = await requestPaymentEntry(entryArgs(state, fetchImpl)); assert.ok(current);
    const page = await fetchImpl(current.paymentUrl); assert.equal(page.status, 200);
    assert.match(await page.text(), /amount=7\.34/);
    state.block(); assert.equal((await fetchImpl(current.paymentUrl)).status, 403);
    assert.equal(await requestPaymentEntry(entryArgs(state, fetchImpl)), null);
  });
});

test('actual backend availability failures remain generic in the extension', async () => {
  const state = fixture();
  await localBackend(async () => { throw new Error('SYNTHETIC PRIVATE PROVIDER DIAGNOSTIC'); }, async fetchImpl => {
    await assert.rejects(requestPaymentEntry(entryArgs(state, fetchImpl)), error => error.message === 'Payment details are temporarily unavailable');
  });
});

test('malformed, root-only and ambiguous successful envelopes never expose a payment control', async () => {
  const state = fixture();
  const data = { paymentUrl: `${APP}/shopify/payment?access=e30.e30.${'A'.repeat(43)}`, expiresAt: NOW + 290000, quoteRevision: 1 };
  for (const payload of [data, { data: null }, { data: [] }, { data, error: { message: 'SYNTHETIC PRIVATE ERROR' } }, { data: { ...data, bankDetails: 'SYNTHETIC PRIVATE FIELD' } }, { data: { ...data, quoteRevision: undefined } }]) {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => payload });
    await assert.rejects(requestPaymentEntry(entryArgs(state, fetchImpl)), error => error.message === 'Payment entry is invalid or expired');
  }
  const malformedJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('SYNTHETIC PRIVATE JSON SOURCE'); } });
  await assert.rejects(requestPaymentEntry(entryArgs(state, malformedJson)), error => error.message === 'Payment entry is invalid or expired');
  const malformedUrl = async () => ({ ok: true, status: 200, json: async () => ({ data: { ...data, paymentUrl: 'SYNTHETIC PRIVATE INVALID URL' } }) });
  await assert.rejects(requestPaymentEntry(entryArgs(state, malformedUrl)), error => error.message === 'Payment entry destination is invalid');
  for (const status of [401, 403, 404, 409]) {
    const fetchImpl = async () => ({ ok: false, status, json: () => { assert.fail('denial details are not read'); } });
    assert.equal(await requestPaymentEntry(entryArgs(state, fetchImpl)), null);
  }
});
