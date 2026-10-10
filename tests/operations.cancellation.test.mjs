import assert from 'node:assert/strict';
import test from 'node:test';
import { createCancellationService, CANCELLATION_GRAPHQL } from '../extensions/shopify-bridge/src/services/cancellation.js';
import { createOrderOperationHandler } from '../extensions/shopify-bridge/src/api/shopifyOrderOperation/[auth]operation.js';

const shop = 'synthetic.myshopify.com'; const id = 'gid://shopify/Order/1000'; const lineId = 'gid://shopify/LineItem/2000';
const location = 'gid://shopify/Location/1'; const key = `order-restock:${id}`;
const input = { orderId: id, operationKey: 'synthetic-cancel-1000', merchantConfirmed: true, reason: 'INVENTORY' };
const bag = (amount) => ({ shopMoney: { amount, currencyCode: 'USD' } });
function fixture() {
  const records = new Map(); const events = []; let locked = false;
  const native = { id, name: '#S1000', currencyCode: 'USD', presentmentCurrencyCode: 'USD', updatedAt: '2026-10-10T01:00:00Z', cancelledAt: null, closed: false, capturable: false,
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED', currentTotalPriceSet: bag('19.99'), totalOutstandingSet: bag('19.99'), totalReceivedSet: bag('0.00'),
    transactions: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'PENDING', manualPaymentGateway: true, paymentDetails: null }], refunds: [], fulfillments: [],
    lineItems: { nodes: [{ id: lineId, sku: 'SHUSHA-L1000-BLACK-S', quantity: 2, currentQuantity: 2 }], pageInfo: { hasNextPage: false } },
    fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', assignedLocation: { location: { id: location, isActive: true, updatedAt: '2026-10-09T00:00:00Z', deactivatedAt: null } },
      lineItems: { nodes: [{ remainingQuantity: 2, lineItem: { id: lineId } }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } };
  const state = { native, records, events, writes: 0, active: true, locationUpdatedAt: '2026-10-09T00:00:00Z', jobDone: true, jobStatus: 'SUCCEEDED', loseResponse: false, failObservation: false, failFreeze: false,
    quote: { shop, orderId: id, revision: 1, paymentVersion: 1, status: 'confirmed', wisePaymentUrl: 'https://wise.com/pay/business/synthetic' }, receipts: [] };
  const mappingStore = { withLock: async (_key, work) => work(), getOperation: async (key) => records.get(key), saveOperation: async (key, record) => { records.set(key, structuredClone(record)); events.push(`save:${record.status}`); } };
  const client = { async request(query, variables, options) {
    if (query === CANCELLATION_GRAPHQL.order) return { shop: { myshopifyDomain: shop }, order: structuredClone(native) };
    if (query === CANCELLATION_GRAPHQL.locations) return { nodes: [{ id: location, isActive: state.active, updatedAt: state.locationUpdatedAt, deactivatedAt: null }] };
    if (query === CANCELLATION_GRAPHQL.job) return { node: { id: variables.id, done: state.jobDone, status: state.jobStatus, errors: [], order: { id } } };
    assert.equal(query, CANCELLATION_GRAPHQL.cancel); assert.equal(locked, true); assert.equal(options.safeRetry, false);
    assert.match(query, /notifyCustomer:false/); assert.match(query, /originalPaymentMethodsRefund:false/); assert.match(query, /restock:true/);
    assert.equal(records.get(key).status, 'in-flight'); assert.equal(state.quote.status, 'inactive'); state.writes += 1;
    native.cancelledAt = '2026-10-10T02:00:00Z'; native.updatedAt = native.cancelledAt;
    if (state.loseResponse) throw new Error('Synthetic response loss');
    return { orderCancel: { orderCancelUserErrors: [], jobResult: { id: 'gid://shopify/OrderCancelJobResult/abc-1' } } };
  } };
  state.service = createCancellationService({ shop, client, mappingStore, writesEnabled: true, approvedLocationIds: [location],
    quoteRepository: { withOrderLock: async (_id, work) => { locked = true; try { return await work(); } finally { locked = false; } },
      getQuote: async () => state.quote, saveQuote: async (_id, quote) => { state.quote = structuredClone(quote); events.push('quote-inactive'); }, listReceipts: async () => state.receipts },
    observeOrder: async (order, options) => {
      if (order.cancelledAt) { assert.equal(records.get(key).status, 'complete'); assert.equal(options.restockEvidence[lineId], 2); if (state.failObservation) throw new Error('Synthetic ingest crash'); }
      events.push(order.cancelledAt ? 'observe-canceled' : 'observe-before');
    },
    assertMappedLines: async () => {}, freezeCapacity: async () => { if (state.failFreeze) throw new Error('Synthetic freeze persistence failure'); events.push('frozen'); }
  });
  return state;
}

test('unpaid manual cancellation invalidates the quote and persists verified proof before observing release', async () => {
  const state = fixture(); assert.equal((await state.service.cancel(input)).status, 'complete');
  assert.equal(state.writes, 1); assert.equal(state.quote.paymentVersion, 2); assert.equal(state.quote.wisePaymentUrl, null);
  assert.equal(state.records.get(key).restockEvidence[lineId], 2);
  assert.ok(state.events.indexOf('quote-inactive') < state.events.indexOf('save:in-flight'));
  assert.ok(state.events.indexOf('save:complete') < state.events.indexOf('observe-canceled'));
  assert.equal((await state.service.cancel(input)).alreadyComplete, true); assert.equal(state.writes, 1);
});

test('an asynchronous job retries only original readback and never another cancellation', async () => {
  const state = fixture(); state.jobDone = false;
  assert.equal((await state.service.cancel(input)).status, 'pending'); assert.equal(state.records.get(key).status, 'pending');
  assert.equal(state.writes, 1); state.jobDone = true;
  assert.equal((await state.service.reconcile(input)).status, 'complete'); assert.equal(state.writes, 1);
});

test('unknown mutation response freezes the original intent without blind replay or invented release', async () => {
  const state = fixture(); state.loseResponse = true;
  assert.equal((await state.service.cancel(input)).requiresMerchantReview, true);
  assert.equal(state.records.get(key).status, 'unknown'); assert.equal(state.records.get(key).restockEvidence, undefined);
  assert.equal((await state.service.cancel(input)).status, 'unknown'); assert.equal(state.writes, 1); assert.ok(state.events.includes('frozen'));
  await assert.rejects(state.service.cancel({ ...input, operationKey: 'another-cancel-1000' }), /original merchant intent/);
});

test('an unknown cancel intent retries a failed local freeze without resending the mutation', async () => {
  const state = fixture(); state.loseResponse = true; state.failFreeze = true;
  await assert.rejects(state.service.cancel(input), /freeze persistence failure/); assert.equal(state.records.get(key).status, 'unknown');
  state.failFreeze = false; assert.equal((await state.service.reconcile(input)).requiresMerchantReview, true);
  assert.equal(state.writes, 1); assert.ok(state.events.includes('frozen')); assert.equal(state.records.get(key).restockEvidence, undefined);
});

test('paid, card, authorized, partial-receipt and edited orders never reach orderCancel', async () => {
  for (const change of [
    (s) => { s.native.displayFinancialStatus = 'PAID'; },
    (s) => { s.native.transactions[0].manualPaymentGateway = false; },
    (s) => { s.native.transactions[0].kind = 'AUTHORIZATION'; },
    (s) => { s.native.presentmentCurrencyCode = 'EUR'; },
    (s) => { s.receipts.push({ reference: 'SYNTHETIC-ONLY' }); },
    (s) => { s.native.lineItems.nodes[0].currentQuantity = 1; }
  ]) { const state = fixture(); change(state); await assert.rejects(state.service.cancel(input)); assert.equal(state.writes, 0); }
});

test('deactivated locations, incomplete allocations and unconfirmed merchant actions are rejected before cancellation', async () => {
  for (const change of [
    (s) => { s.native.fulfillmentOrders.nodes[0].assignedLocation.location.isActive = false; },
    (s) => { s.native.fulfillmentOrders.pageInfo.hasNextPage = true; },
    (s) => { s.native.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity = 1; }
  ]) { const state = fixture(); change(state); await assert.rejects(state.service.cancel(input)); assert.equal(state.writes, 0); }
  const state = fixture(); await assert.rejects(state.service.cancel({ ...input, merchantConfirmed: false })); assert.equal(state.writes, 0);
});

test('successful canceled status alone cannot release changed or deactivated native stock', async () => {
  for (const change of [(s) => { s.active = false; }, (s) => { s.jobStatus = 'FAILED'; }, (s) => { s.locationUpdatedAt = '2026-10-10T02:00:00Z'; }]) {
    const state = fixture(); state.jobDone = false; await state.service.cancel(input); state.jobDone = true; change(state);
    await assert.rejects(state.service.reconcile(input)); assert.equal(state.records.get(key).status, 'review');
    assert.equal(state.records.get(key).restockEvidence, undefined); assert.ok(state.events.includes('frozen')); assert.equal(state.writes, 1);
  }
});

test('a crash after complete proof recovers only ingestion and preserves the native cancellation', async () => {
  const state = fixture(); state.failObservation = true; await assert.rejects(state.service.cancel(input), /ingest crash/);
  assert.equal(state.records.get(key).status, 'complete'); state.failObservation = false;
  assert.equal((await state.service.reconcile(input)).alreadyComplete, true); assert.equal(state.writes, 1);
});

test('private operation API requires admin and all five explicit phase-four gates', async () => {
  let called = 0; const getService = async () => { called += 1; return { cancel: async () => ({ status: 'complete' }) }; };
  const response = () => ({ code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const env = Object.fromEntries(['SHOPIFY_BRIDGE_ENABLED','SHOPIFY_BRIDGE_WRITES_ENABLED','SHOPIFY_SHARED_CAPACITY_ENABLED','SHOPIFY_PAYMENT_OPERATIONS_ENABLED','SHOPIFY_ORDER_OPERATIONS_ENABLED'].map((key) => [key, 'true']));
  env.SHOPIFY_APP_URL = 'https://synthetic.example.test';
  const request = { get: () => env.SHOPIFY_APP_URL, getCurrentUser: () => ({ uuid: 'synthetic-admin' }), body: { ...input, action: 'cancel' } };
  let result = response(); await createOrderOperationHandler({ env, getService })({ ...request, getCurrentUser: () => null }, result); assert.equal(result.code, 401);
  for (const gate of Object.keys(env).filter((key) => key !== 'SHOPIFY_APP_URL')) { result = response(); await createOrderOperationHandler({ env: { ...env, [gate]: 'false' }, getService })(request, result); assert.equal(result.code, 503); }
  result = response(); await createOrderOperationHandler({ env, getService })({ ...request, get: () => 'https://other.example.test' }, result); assert.equal(result.code, 403);
  assert.equal(createOrderOperationHandler({ env, getService }).length, 3);
  assert.equal(called, 0); result = response(); await createOrderOperationHandler({ env, getService })(request, result); assert.equal(result.code, 200); assert.equal(called, 1);
});
