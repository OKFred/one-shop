import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPaymentService, PAYMENT_GRAPHQL, readOrderMoney, privateReceivingDetails, decimalMoney } from '../extensions/shopify-bridge/src/services/payments.js';
import { createCustomerPaymentAccess, verifyCustomerSessionToken } from '../extensions/shopify-bridge/src/services/customerAccess.js';
import { createFulfillmentService, FULFILLMENT_GRAPHQL } from '../extensions/shopify-bridge/src/services/fulfillment.js';
import { requestPaymentEntry } from '../shopify/extensions/wise-payment/src/payment-entry.js';

// All fixtures are invented. No token, customer, bank or order fixture comes
// from a store; fake clients never issue HTTP requests.
const SHOP = 'synthetic-shusha.myshopify.com', ORDER = 'gid://shopify/Order/100', CUSTOMER = 'gid://shopify/Customer/200';
const APP = 'https://app.example.test', APP_SECRET = 'synthetic-app-secret-for-tests-only', ACCESS_SECRET = 'synthetic-independent-access-secret-for-tests-only';
const NOW = Date.parse('2026-10-10T01:02:03.456Z'), second = Math.floor(NOW / 1000);
const gateways = ['Bank Deposit'];
const receiving = { verified: true, bankDetails: [{ label: 'Beneficiary', value: 'Synthetic test only' }], wiseBusinessOpenLink: 'https://wise.com/pay/business/synthetic-fixture' };
const clone = value => value === undefined ? undefined : structuredClone(value);
const bag = value => ({ shopMoney: { amount: value, currencyCode: 'USD' }, presentmentMoney: { amount: value, currencyCode: 'USD' } });
const cents = value => BigInt(value.replace('.', ''));
const amount = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
function orderFixture() {
  return { id: ORDER, legacyResourceId: '100', customer: { id: CUSTOMER }, cancelledAt: null, closed: false, currencyCode: 'USD', presentmentCurrencyCode: 'USD', displayFinancialStatus: 'PENDING', canMarkAsPaid: true, capturable: false, paymentGatewayNames: gateways,
    currentTotalPriceSet: bag('23.25'), currentSubtotalPriceSet: bag('20.00'), currentShippingPriceSet: bag('0.00'), currentTotalTaxSet: bag('3.25'), currentTotalDiscountsSet: bag('0.00'), totalOutstandingSet: bag('23.25'), totalReceivedSet: bag('0.00'),
    transactions: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'PENDING', gateway: 'Bank Deposit', manualPaymentGateway: true, paymentDetails: null }] };
}
function repoFixture() {
  const quotes = new Map(), operations = new Map(), receipts = new Map(), events = [];
  return { quotes, operations, receipts, events,
    withOrderLock: async (_, fn) => fn(),
    getQuote: async id => clone(quotes.get(id)), saveQuote: async (id, value) => { quotes.set(id, clone(value)); events.push({ type: 'quote', value: clone(value) }); },
    getOperation: async key => clone(operations.get(key)), saveOperation: async (key, value) => { operations.set(key, clone(value)); events.push({ type: 'operation', value: clone(value) }); },
    getReceipt: async reference => clone(receipts.get(reference)),
    claimReceipt: async receipt => {
      const prior = receipts.get(receipt.reference);
      if (prior && ['platform', 'orderKey', 'amount', 'currency', 'quoteRevision'].some(key => prior[key] !== receipt[key])) throw new Error('Global duplicate actual receipt');
      if (!prior) receipts.set(receipt.reference, clone(receipt));
      return { created: !prior };
    },
    listReceipts: async key => [...receipts.values()].filter(r => r.orderKey === key).map(clone)
  };
}
function fakePaymentAdmin(repository, options = {}) {
  const order = orderFixture(), calls = []; let calculated;
  function calcMoney(shipping) { const total = amount(2325n + cents(shipping)); return { id: 'gid://shopify/CalculatedOrder/300', subtotalPriceSet: bag('20.00'), totalPriceSet: bag(total), totalOutstandingSet: bag(total), taxLines: [{ priceSet: bag('3.25') }], shippingLines: [{ id: 'gid://shopify/CalculatedShippingLine/400', title: 'Request', stagedStatus: 'NONE', price: bag(shipping) }] }; }
  const client = { async request(document, variables, requestOptions) {
    calls.push({ document, variables: clone(variables), options: clone(requestOptions) });
    if (document === PAYMENT_GRAPHQL.order) return { shop: { myshopifyDomain: options.wrongShop ? 'other.myshopify.com' : SHOP }, order: clone(order) };
    assert.equal(requestOptions.safeRetry, false, 'external mutations cannot be retried');
    const key = Object.entries(PAYMENT_GRAPHQL).find(([, text]) => text === document)?.[0];
    assert.ok(key, 'only documented GraphQL operations are emitted');
    if (key === 'begin') {
      assert.equal(repository.quotes.get(ORDER).status, 'inactive', 'old payment quote invalidated before external write');
      assert.equal([...repository.operations.values()].at(-1).status, 'in-flight', 'intent committed before external write');
      if (options.unknownBegin) throw new Error('synthetic response lost');
      calculated = calcMoney('0.00'); if (options.addedExisting) calculated.shippingLines[0].stagedStatus = 'ADDED';
      return { orderEditBegin: { calculatedOrder: clone(calculated), userErrors: [] } };
    }
    if (key === 'remove') { calculated.shippingLines = []; return { orderEditRemoveShippingLine: { calculatedOrder: clone(calculated), userErrors: [] } }; }
    if (key === 'add' || key === 'update') {
      calculated = calcMoney(variables.shippingLine.price.amount); calculated.shippingLines[0].title = variables.shippingLine.title; calculated.shippingLines[0].stagedStatus = 'ADDED';
      return { [key === 'add' ? 'orderEditAddShippingLine' : 'orderEditUpdateShippingLine']: { calculatedOrder: clone(calculated), userErrors: [] } };
    }
    if (key === 'commit') {
      assert.match(document, /notifyCustomer: false/);
      order.currentShippingPriceSet = clone(calculated.shippingLines[0].price); order.currentTotalPriceSet = clone(calculated.totalPriceSet); order.totalOutstandingSet = clone(calculated.totalOutstandingSet);
      if (options.taxMismatch) order.currentTotalTaxSet = bag('3.26');
      return { orderEditCommit: { order: { id: ORDER }, userErrors: [] } };
    }
    if (key === 'paid') {
      order.displayFinancialStatus = 'PAID'; order.canMarkAsPaid = false; order.totalOutstandingSet = bag('0.00'); order.totalReceivedSet = clone(order.currentTotalPriceSet); order.transactions[0].status = 'SUCCESS';
      if (options.unknownPaid) throw new Error('synthetic paid response lost');
      return { orderMarkAsPaid: { order: clone(order), userErrors: [] } };
    }
    throw new Error('Unsupported synthetic operation');
  } };
  return { client, order, calls };
}
function paymentSetup(options = {}) {
  const repository = repoFixture(); const admin = fakePaymentAdmin(repository, options);
  const service = createPaymentService({ shop: SHOP, client: admin.client, repository, receivingConfig: clone(receiving), allowedManualGateways: gateways, writesEnabled: true, now: () => NOW });
  return { ...admin, repository, service };
}
function quoteInput(shippingAmount = '0.00') { return { orderId: ORDER, operationKey: 'synthetic_quote_operation_1', expectedQuoteRevision: 0, shippingTitle: 'Confirmed manual shipping', shippingAmount, merchantAvailabilityConfirmed: true }; }
function receiptInput(reference = 'SYNTHETIC-RECEIPT-1', value = '10.00') { return { orderId: ORDER, receiptReference: reference, amount: value, currency: 'USD', quoteRevision: 1, receivedConfirmed: true }; }
function paidInput() { return { orderId: ORDER, operationKey: 'synthetic_paid_operation_1', quoteRevision: 1, receivedConfirmed: true, markPaidConfirmed: true }; }
function jwt(payload, secret = APP_SECRET, header = { alg: 'HS256', typ: 'JWT' }) {
  const parts = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${parts}.${createHmac('sha256', secret).update(parts).digest('base64url')}`;
}
function sessionPayload(extra = {}) { return { aud: 'synthetic-client', dest: SHOP, sub: CUSTOMER, iat: second, nbf: second, exp: second + 300, ...extra }; }
function accessSetup(base, clock = () => NOW) { return createCustomerPaymentAccess({ shop: SHOP, client: base.client, repository: base.repository, appSecret: APP_SECRET, clientId: 'synthetic-client', accessSecret: ACCESS_SECRET, appUrl: APP, allowedManualGateways: gateways, now: clock }); }

test('signed Shopify customer sessions reject algorithm, signature, app, destination, expiry and missing customer', () => {
  const config = { shop: SHOP, appSecret: APP_SECRET, clientId: 'synthetic-client', now: () => NOW };
  assert.equal(verifyCustomerSessionToken(jwt(sessionPayload()), config).customerId, CUSTOMER);
  assert.equal(verifyCustomerSessionToken(jwt(sessionPayload({ dest: `https://${SHOP}` })), config).shop, SHOP);
  for (const token of [jwt(sessionPayload(), APP_SECRET, { alg: 'none' }), jwt(sessionPayload(), 'wrong-synthetic-secret'), jwt(sessionPayload({ aud: 'other-app' })), jwt(sessionPayload({ dest: 'other.myshopify.com' })), jwt(sessionPayload({ exp: second })), jwt(sessionPayload({ nbf: second + 1 })), jwt(sessionPayload({ sub: undefined })), jwt(sessionPayload({ sub: 'gid://shopify/Order/200' }))]) assert.throws(() => verifyCustomerSessionToken(token, config));
});

test('native quote shipping supports zero/fractional USD with durable invalidation and no customer notification', async () => {
  for (const shipping of ['0.00', '7.35']) {
    const setup = paymentSetup(); const result = await setup.service.confirmShippingQuote(quoteInput(shipping));
    assert.equal(result.quote.shippingAmount, shipping); assert.equal(result.quote.amount, amount(2325n + cents(shipping))); assert.equal(result.customerNotified, false);
    assert.deepEqual(setup.calls.filter(c => c.document.startsWith('mutation')).map(c => Object.entries(PAYMENT_GRAPHQL).find(([, doc]) => doc === c.document)[0]), ['begin', 'remove', 'add', 'commit']);
    assert.equal(setup.repository.events[0].type, 'operation'); assert.equal(setup.repository.events[1].value.status, 'inactive');
    const count = setup.calls.length; assert.equal((await setup.service.confirmShippingQuote(quoteInput(shipping))).alreadyComplete, true); assert.equal(setup.calls.length, count);
  }
});

test('calculated added shipping uses native update; native tax mismatch never activates payment', async () => {
  const updated = paymentSetup({ addedExisting: true }); await updated.service.confirmShippingQuote(quoteInput('2.15'));
  assert.ok(updated.calls.some(c => c.document === PAYMENT_GRAPHQL.update)); assert.ok(!updated.calls.some(c => c.document === PAYMENT_GRAPHQL.add));
  const mismatch = paymentSetup({ taxMismatch: true }); await assert.rejects(mismatch.service.confirmShippingQuote(quoteInput('2.15')), /readback/);
  assert.equal(mismatch.repository.quotes.get(ORDER).status, 'inactive'); assert.equal(mismatch.repository.operations.get('synthetic_quote_operation_1').status, 'readback-mismatch');
});

test('unknown order edit outcome is frozen and original quote remains inactive', async () => {
  const setup = paymentSetup({ unknownBegin: true }); await assert.rejects(setup.service.confirmShippingQuote(quoteInput()), /unknown/);
  const mutations = setup.calls.filter(c => c.document.startsWith('mutation')).length;
  await assert.rejects(setup.service.confirmShippingQuote(quoteInput()), /unresolved/);
  await assert.rejects(setup.service.confirmShippingQuote({ ...quoteInput(), operationKey: 'different_quote_operation_2' }), /unresolved/);
  assert.equal(setup.calls.filter(c => c.document.startsWith('mutation')).length, mutations); assert.equal(setup.repository.quotes.get(ORDER).status, 'inactive');
});

test('customer access is issued only for signed owner, live shop and unchanged confirmed quote', async () => {
  const setup = paymentSetup(); const access = accessSetup(setup);
  await assert.rejects(access.issue(jwt(sessionPayload()), ORDER), /active/);
  await setup.service.confirmShippingQuote(quoteInput());
  await assert.rejects(access.issue(jwt(sessionPayload({ sub: 'gid://shopify/Customer/201' })), ORDER), /own/);
  await assert.rejects(access.issue(jwt(sessionPayload({ sub: undefined })), ORDER), /signed-in/);
  const entry = await access.issue(jwt(sessionPayload()), ORDER); const token = new URL(entry.paymentUrl).searchParams.get('access');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); assert.equal(claims.quoteRevision, 1); assert.equal(claims.exp - claims.iat, 300); assert.equal(claims.bankDetails, undefined); assert.equal(claims.wisePaymentUrl, undefined);
  assert.equal((await access.redeem(token)).quote.amount, '23.25');
  await assert.rejects(accessSetup(setup, () => NOW + 300000).redeem(token), /Expired/);
  setup.order.cancelledAt = '2026-10-10T01:03:00Z'; await assert.rejects(access.redeem(token), /cancelled/);
  setup.order.cancelledAt = null; setup.order.currentTotalTaxSet = bag('3.26'); await assert.rejects(access.redeem(token), /changed/);
  const other = paymentSetup({ wrongShop: true }); await assert.rejects(accessSetup(other).issue(jwt(sessionPayload()), ORDER), /verified store/);
});

test('quote and partial receipt versions invalidate issued payment credentials without embedding bank data', async () => {
  const setup = paymentSetup(); await setup.service.confirmShippingQuote(quoteInput()); const access = accessSetup(setup);
  const oldToken = new URL((await access.issue(jwt(sessionPayload()), ORDER)).paymentUrl).searchParams.get('access');
  await setup.service.recordReceipt(receiptInput()); await assert.rejects(access.redeem(oldToken), /changed/);
  const newToken = new URL((await access.issue(jwt(sessionPayload()), ORDER)).paymentUrl).searchParams.get('access');
  assert.equal((await access.redeem(newToken)).quote.amount, '13.25');
  setup.repository.quotes.get(ORDER).revision++; await assert.rejects(access.redeem(newToken), /changed/);
});

test('partial receipts remain central, update remaining Wise amount and preserve frozen bank configuration', async () => {
  const setup = paymentSetup(); await setup.service.confirmShippingQuote(quoteInput());
  const nativeMutations = setup.calls.filter(c => c.document.startsWith('mutation')).length;
  const first = await setup.service.recordReceipt(receiptInput('synthetic-receipt-1', '10.00'));
  assert.equal(first.quote.status, 'partial'); assert.equal(first.quote.remainingAmount, '13.25'); assert.equal(new URL(first.quote.wisePaymentUrl).searchParams.get('amount'), '13.25'); assert.equal(first.nativeMarkedPaid, false);
  const repeated = await setup.service.recordReceipt(receiptInput()); assert.equal(repeated.alreadyRecorded, true); assert.equal(repeated.quote.receivedAmount, '10.00'); assert.equal(repeated.quote.paymentVersion, first.quote.paymentVersion);
  assert.equal(setup.calls.filter(c => c.document.startsWith('mutation')).length, nativeMutations);
  await assert.rejects(setup.service.markPaid(paidInput()), /Full actual/);
  await assert.rejects(setup.service.confirmShippingQuote({ ...quoteInput(), expectedQuoteRevision: 1, operationKey: 'requote_operation_2' }), /received funds/);
});

test('receipt reference is globally unique across platforms, orders, amounts and revisions', async () => {
  const setup = paymentSetup(); await setup.service.confirmShippingQuote(quoteInput());
  setup.repository.receipts.set('SYNTHETIC-RECEIPT-1', { reference: 'SYNTHETIC-RECEIPT-1', platform: 'evershop', orderKey: 'synthetic-legacy-order', currency: 'USD', amount: '10.00', quoteRevision: 1 });
  await assert.rejects(setup.service.recordReceipt(receiptInput()), /already claimed/);
  setup.repository.receipts.clear(); await setup.service.recordReceipt(receiptInput());
  await assert.rejects(setup.service.recordReceipt(receiptInput('SYNTHETIC-RECEIPT-1', '11.00')), /another amount/);
  await assert.rejects(setup.service.recordReceipt({ ...receiptInput('SYNTHETIC-RECEIPT-1'), quoteRevision: 2 }), /another amount/);
});

test('full receipts require a separate explicit native paid action and native paid readback', async () => {
  const setup = paymentSetup(); await setup.service.confirmShippingQuote(quoteInput());
  const received = await setup.service.recordReceipt(receiptInput('SYNTHETIC-FULL-RECEIPT', '23.25'));
  assert.equal(received.quote.status, 'received'); assert.equal(received.quote.wisePaymentUrl, null); assert.equal(received.requiresExplicitMarkPaid, true); assert.equal(setup.order.displayFinancialStatus, 'PENDING');
  await assert.rejects(setup.service.markPaid({ ...paidInput(), markPaidConfirmed: false }), /Explicitly/);
  const result = await setup.service.markPaid(paidInput()); assert.equal(result.nativeVerified, true); assert.equal(result.quote.status, 'paid'); assert.equal(setup.order.displayFinancialStatus, 'PAID');
  const paidCalls = setup.calls.filter(c => c.document === PAYMENT_GRAPHQL.paid).length; assert.equal((await setup.service.markPaid(paidInput())).alreadyComplete, true); assert.equal(setup.calls.filter(c => c.document === PAYMENT_GRAPHQL.paid).length, paidCalls);
});

test('online gateways, card authorizations and capturable funds never reach orderMarkAsPaid', async () => {
  for (const change of [order => { order.capturable = true; }, order => { order.displayFinancialStatus = 'AUTHORIZED'; }, order => { order.paymentGatewayNames = ['shopify_payments']; }, order => { order.transactions[0].kind = 'AUTHORIZATION'; }, order => { order.transactions[0].paymentDetails = { __typename: 'CardPaymentDetails' }; }, order => { order.transactions[0].manualPaymentGateway = false; }]) {
    const setup = paymentSetup(); await setup.service.confirmShippingQuote(quoteInput()); await setup.service.recordReceipt(receiptInput('SYNTHETIC-FULL-RECEIPT', '23.25')); change(setup.order);
    await assert.rejects(setup.service.markPaid(paidInput())); assert.equal(setup.calls.filter(c => c.document === PAYMENT_GRAPHQL.paid).length, 0);
  }
});

test('unknown paid response is reconciled by native readback without mutation replay', async () => {
  const setup = paymentSetup({ unknownPaid: true }); await setup.service.confirmShippingQuote(quoteInput()); await setup.service.recordReceipt(receiptInput('SYNTHETIC-FULL-RECEIPT', '23.25'));
  await assert.rejects(setup.service.markPaid(paidInput()), /unknown/); await assert.rejects(setup.service.markPaid(paidInput()), /unresolved/);
  await assert.rejects(setup.service.markPaid({ ...paidInput(), operationKey: 'new_synthetic_paid_operation_2' }), /unresolved/);
  assert.equal(setup.repository.quotes.get(ORDER).status, 'received'); const result = await setup.service.reconcilePaid('synthetic_paid_operation_1'); assert.equal(result.replayed, false); assert.equal(result.quote.status, 'paid'); assert.equal(setup.calls.filter(c => c.document === PAYMENT_GRAPHQL.paid).length, 1);
});

test('writes default disabled and decimal/receiver configuration are strict', async () => {
  for (const input of ['1.001', '-1.00', '1e2', 'NaN', 1, '01.00']) assert.throws(() => decimalMoney(input));
  assert.equal(decimalMoney('0', { zero: true }), '0.00'); assert.throws(() => decimalMoney('0'));
  for (const link of ['https://wise.com.evil.test/pay/business/fixture', 'https://wise.com/pay/business/fixture?bad=1', 'http://wise.com/pay/business/fixture']) assert.throws(() => privateReceivingDetails({ ...receiving, wiseBusinessOpenLink: link }, { amount: '1.00', reference: 'SYNTHETIC' }));
  const repository = repoFixture(), admin = fakePaymentAdmin(repository); const service = createPaymentService({ shop: SHOP, client: admin.client, repository }); await assert.rejects(service.confirmShippingQuote(quoteInput()), /disabled/); assert.equal(admin.calls.length, 0);
});

test('canonical unresolved cancellation guards execute inside order locks before payment writes or customer credentials', async () => {
  const setup = paymentSetup(); await setup.service.confirmShippingQuote(quoteInput()); const access = accessSetup(setup);
  const credential = new URL((await access.issue(jwt(sessionPayload()), ORDER)).paymentUrl).searchParams.get('access');
  let locked = false;
  setup.repository.withOrderLock = async (_, work) => { locked = true; try { return await work(); } finally { locked = false; } };
  setup.repository.assertOrderOperable = async id => { assert.equal(id, ORDER); assert.equal(locked, true); throw new Error('Canonical cancellation outcome is unresolved'); };
  const before = setup.calls.length;
  await assert.rejects(setup.service.confirmShippingQuote({ ...quoteInput(), expectedQuoteRevision: 1, operationKey: 'synthetic_guarded_quote_operation' }), /cancellation/);
  await assert.rejects(setup.service.recordReceipt(receiptInput()), /cancellation/);
  await assert.rejects(setup.service.markPaid(paidInput()), /cancellation/);
  assert.equal(setup.calls.length, before, 'guard prevents any native request');
  await assert.rejects(access.issue(jwt(sessionPayload()), ORDER), /cancellation/); await assert.rejects(access.redeem(credential), /cancellation/);
  assert.equal(setup.calls.length, before);
});

test('delayed customer redemption serializes its private snapshot with canonical cancellation', async () => {
  const setup = paymentSetup(); await setup.service.confirmShippingQuote(quoteInput()); const access = accessSetup(setup);
  const credential = new URL((await access.issue(jwt(sessionPayload()), ORDER)).paymentUrl).searchParams.get('access');
  let tail = Promise.resolve(), locked = false, canceled = false;
  const events = [];
  setup.repository.withOrderLock = async (id, work) => {
    assert.equal(id, ORDER); const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; });
    await previous; locked = true;
    try { return await work(); } finally { locked = false; unlock(); }
  };
  setup.repository.assertOrderOperable = async () => { assert.equal(locked, true); if (canceled) throw new Error('Canonical cancellation is complete'); };
  const getQuote = setup.repository.getQuote;
  setup.repository.getQuote = async id => { assert.equal(locked, true); assert.equal(canceled, false); events.push('authorized-snapshot'); return getQuote(id); };
  let nativeEntered, resumeNative;
  const entered = new Promise(resolve => { nativeEntered = resolve; }); const resume = new Promise(resolve => { resumeNative = resolve; });
  const request = setup.client.request;
  setup.client.request = async (...args) => { if (args[0] === PAYMENT_GRAPHQL.order) { nativeEntered(); await resume; } return request(...args); };
  const redeem = access.redeem(credential); await entered;
  const cancellation = setup.repository.withOrderLock(ORDER, async () => { events.push('canonical-cancellation'); canceled = true; const quote = setup.repository.quotes.get(ORDER); quote.status = 'inactive'; });
  await Promise.resolve(); assert.equal(canceled, false, 'cancellation cannot invalidate the quote inside a customer snapshot');
  resumeNative(); const [result] = await Promise.all([redeem, cancellation]);
  assert.equal(result.quote.amount, '23.25'); assert.deepEqual(events, ['authorized-snapshot', 'canonical-cancellation']);
  const before = setup.calls.length;
  await assert.rejects(access.redeem(credential), /cancellation is complete/);
  await assert.rejects(access.issue(jwt(sessionPayload()), ORDER), /cancellation is complete/);
  assert.equal(setup.calls.length, before, 'a completed cancel blocks stale native payment snapshots before provider reads');
});

test('session and payment credentials that expire waiting for an order lock never disclose or issue access', async () => {
  const setup = paymentSetup(); await setup.service.confirmShippingQuote(quoteInput()); let currentTime = NOW;
  const access = accessSetup(setup, () => currentTime);
  const credential = new URL((await access.issue(jwt(sessionPayload()), ORDER)).paymentUrl).searchParams.get('access');
  setup.repository.withOrderLock = async (_id, work) => { currentTime += 301_000; return work(); };
  const before = setup.calls.length;
  await assert.rejects(access.redeem(credential), /Expired/);
  currentTime = NOW; await assert.rejects(access.issue(jwt(sessionPayload()), ORDER), /Expired/);
  assert.equal(setup.calls.length, before);
  const incomplete = { ...setup, repository: { ...setup.repository, withOrderLock: undefined } };
  assert.throws(() => accessSetup(incomplete), /authentication is not configured/);
});

const FO = 'gid://shopify/FulfillmentOrder/500', FOLI = 'gid://shopify/FulfillmentOrderLineItem/600', LINE = 'gid://shopify/LineItem/700', LOCATION = 'gid://shopify/Location/800';
function shipmentInput() { return { orderId: ORDER, operationKey: 'synthetic_shipment_operation_1', actualShippedConfirmed: true, trackingInfo: { company: 'DHL', number: 'SYNTHETIC-TRACKING-ONLY' }, lines: [{ fulfillmentOrderId: FO, fulfillmentOrderLineItemId: FOLI, quantity: 1 }] }; }
function fulfillmentSetup(options = {}) {
  const repository = repoFixture(); repository.quotes.set(ORDER, { shop: SHOP, orderId: ORDER, status: 'paid', nativeMoney: { total: '23.25' } });
  const order = { id: ORDER, cancelledAt: null, closed: false, displayFinancialStatus: 'PAID', currentTotalPriceSet: bag('23.25'), totalOutstandingSet: bag('0.00'), fulfillments: [], fulfillmentOrders: { nodes: [{ id: FO, status: 'OPEN', assignedLocation: { location: { id: LOCATION } }, lineItems: { nodes: [{ id: FOLI, remainingQuantity: 2, lineItem: { id: LINE } }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } };
  const calls = [], client = { async request(document, variables, requestOptions) {
    calls.push({ document, variables: clone(variables), options: requestOptions });
    if (document === FULFILLMENT_GRAPHQL.order) return { shop: { myshopifyDomain: SHOP }, order: clone(order) };
    assert.equal(document, FULFILLMENT_GRAPHQL.create); assert.equal(requestOptions.safeRetry, false); assert.equal([...repository.operations.values()].at(-1).status, 'in-flight');
    const actual = { id: 'gid://shopify/Fulfillment/900', status: 'SUCCESS', createdAt: '2026-10-10T01:02:03Z', trackingInfo: [clone(variables.fulfillment.trackingInfo)], fulfillmentLineItems: { nodes: [{ quantity: 1, lineItem: { id: LINE } }], pageInfo: { hasNextPage: false } } };
    order.fulfillments.push(actual); if (options.unknown) throw new Error('synthetic lost response'); return { fulfillmentCreate: { fulfillment: clone(actual), userErrors: [] } };
  } };
  const service = createFulfillmentService({ shop: SHOP, client, repository, allowedLocationIds: [LOCATION], writesEnabled: true, now: () => NOW }); return { service, order, repository, calls };
}

test('native fulfillment requires actual shipment, paid readback, explicit quantities and verified merchant location', async () => {
  const setup = fulfillmentSetup(); await assert.rejects(setup.service.fulfill({ ...shipmentInput(), actualShippedConfirmed: false }), /actual shipment/);
  await assert.rejects(setup.service.fulfill({ ...shipmentInput(), lines: [] }), /Explicit/);
  await assert.rejects(setup.service.fulfill({ ...shipmentInput(), lines: [{ ...shipmentInput().lines[0], quantity: 3 }] }), /exceeds/);
  setup.order.fulfillmentOrders.nodes[0].assignedLocation.location.id = 'gid://shopify/Location/801'; await assert.rejects(setup.service.fulfill(shipmentInput()), /verified merchant/);
  setup.order.fulfillmentOrders.nodes[0].assignedLocation.location.id = LOCATION; setup.order.displayFinancialStatus = 'PENDING'; await assert.rejects(setup.service.fulfill(shipmentInput()), /paid status/);
  assert.equal(setup.calls.filter(c => c.document === FULFILLMENT_GRAPHQL.create).length, 0);
});

test('verified native fulfillment uses no customer notification and duplicate operation cannot create another shipment', async () => {
  const setup = fulfillmentSetup(); const result = await setup.service.fulfill(shipmentInput()); assert.equal(result.nativeVerified, true); assert.equal(result.customerNotified, false);
  const write = setup.calls.find(c => c.document === FULFILLMENT_GRAPHQL.create); assert.equal(write.variables.fulfillment.notifyCustomer, false); assert.deepEqual(write.variables.fulfillment.lineItemsByFulfillmentOrder, [{ fulfillmentOrderId: FO, fulfillmentOrderLineItems: [{ id: FOLI, quantity: 1 }] }]);
  assert.equal((await setup.service.fulfill(shipmentInput())).alreadyComplete, true); assert.equal(setup.calls.filter(c => c.document === FULFILLMENT_GRAPHQL.create).length, 1);
});

test('unknown native fulfillment is frozen then reconciled using exact tracking and quantities without replay', async () => {
  const setup = fulfillmentSetup({ unknown: true }); await assert.rejects(setup.service.fulfill(shipmentInput()), /unknown/); await assert.rejects(setup.service.fulfill(shipmentInput()), /unresolved/);
  await assert.rejects(setup.service.fulfill({ ...shipmentInput(), operationKey: 'new_synthetic_shipment_operation_2' }), /unresolved/);
  assert.equal((await setup.service.reconcile('synthetic_shipment_operation_1')).replayed, false); assert.equal(setup.calls.filter(c => c.document === FULFILLMENT_GRAPHQL.create).length, 1);
});

test('canonical unresolved cancellation guards native fulfillment before mutation', async () => {
  const setup = fulfillmentSetup(); let locked = false;
  setup.repository.withOrderLock = async (_, work) => { locked = true; try { return await work(); } finally { locked = false; } };
  setup.repository.assertOrderOperable = async () => { assert.equal(locked, true); throw new Error('Canonical cancellation outcome is unresolved'); };
  await assert.rejects(setup.service.fulfill(shipmentInput()), /cancellation/); assert.equal(setup.calls.length, 0);
});

test('native customer UI never requests payment for pre-authenticated or anonymous context', async () => {
  let calls = 0;
  const result = await requestPaymentEntry({ backendOrigin: APP, orderId: ORDER, fullyAuthenticated: false, getSessionToken: async () => { calls++; }, fetchImpl: async () => { calls++; } }); assert.equal(result, null); assert.equal(calls, 0);
});

test('native customer UI sends fresh bearer proof and accepts only short same-origin payment entry', async () => {
  const good = { paymentUrl: `${APP}/shopify/payment?access=e30.e30.${'A'.repeat(43)}`, expiresAt: NOW + 290000, quoteRevision: 1 }; let seen;
  const args = { backendOrigin: APP, orderId: ORDER, fullyAuthenticated: true, now: () => NOW, getSessionToken: async () => 'synthetic-session-token', fetchImpl: async (url, input) => { seen = { url, input }; return { ok: true, status: 200, json: async () => ({ data: good }) }; } };
  assert.deepEqual(await requestPaymentEntry(args), good); assert.equal(seen.input.headers.Authorization, 'Bearer synthetic-session-token'); assert.equal(seen.input.credentials, 'omit'); assert.equal(seen.input.redirect, 'error'); assert.equal(JSON.parse(seen.input.body).orderId, ORDER);
  for (const bad of [{ ...good, paymentUrl: good.paymentUrl.replace(APP, 'https://evil.example.test') }, { ...good, paymentUrl: `${APP}/shopify/payment?access=fixture` }, { ...good, expiresAt: NOW }, { ...good, expiresAt: NOW + 600000 }]) await assert.rejects(requestPaymentEntry({ ...args, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: bad }) }) }));
  assert.equal(await requestPaymentEntry({ ...args, fetchImpl: async () => ({ ok: false, status: 403 }) }), null);
});
