import { createHash } from 'node:crypto';
import { normalizeShop } from './config.js';
import { paymentOrderId, operationKey, decimalMoney } from './payments.js';

const fulfillmentFields = 'id status createdAt trackingInfo { company number url } fulfillmentLineItems(first: 100) { nodes { quantity lineItem { id } } pageInfo { hasNextPage } }';
export const FULFILLMENT_GRAPHQL = Object.freeze({
  order: `query ShushaFulfillmentOrder($id: ID!) { shop { myshopifyDomain } order(id: $id) { id cancelledAt closed displayFinancialStatus currentTotalPriceSet { shopMoney { amount currencyCode } } totalOutstandingSet { shopMoney { amount currencyCode } } fulfillments(first: 100) { ${fulfillmentFields} } fulfillmentOrders(first: 100) { nodes { id status requestStatus assignedLocation { location { id } } lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } }`,
  create: `mutation ShushaManualFulfillment($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { ${fulfillmentFields} } userErrors { field message } } }`
});
function gid(value, type) { if (typeof value !== 'string' || !new RegExp(`^gid://shopify/${type}/\\d+$`).test(value)) throw new Error(`Invalid ${type} identity`); return value; }
function tracking(input) {
  for (const key of ['company', 'number']) if (typeof input?.[key] !== 'string' || !input[key].trim() || input[key].length > 100 || /[\p{Cc}\p{Cf}]/u.test(input[key])) throw new Error('Actual carrier and tracking number are required');
  const result = { company: input.company.trim(), number: input.number.trim() };
  if (input.url) { const url = new URL(input.url); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 2000) throw new Error('Tracking URL must be HTTPS'); result.url = url.href; }
  return result;
}
function normalizedLines(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error('Explicit shipped line items are required');
  const seen = new Set();
  return input.map(line => {
    const fulfillmentOrderId = gid(line.fulfillmentOrderId, 'FulfillmentOrder'); const id = gid(line.fulfillmentOrderLineItemId, 'FulfillmentOrderLineItem');
    if (seen.has(id) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 1000000) throw new Error('Invalid shipped line quantity');
    seen.add(id); return { fulfillmentOrderId, id, quantity: line.quantity };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function exactLines(actual, expected) {
  if (!actual?.nodes || actual.pageInfo?.hasNextPage) return false;
  const amounts = new Map();
  for (const line of actual.nodes) {
    if (!line.lineItem?.id || !Number.isSafeInteger(line.quantity) || line.quantity < 1) return false;
    amounts.set(line.lineItem.id, (amounts.get(line.lineItem.id) || 0) + line.quantity);
  }
  const normalized = [...amounts].map(([id, quantity]) => ({ id, quantity })).sort((a, b) => a.id.localeCompare(b.id));
  return normalized.length === expected.length && normalized.every((line, index) => line.id === expected[index].id && line.quantity === expected[index].quantity);
}
function matches(fulfillment, expected, trackingInfo, startedAt) {
  // Shopify timestamps can lose milliseconds. Match the intent's whole second,
  // while exact native line quantities and actual tracking identify the shipment.
  return fulfillment?.status === 'SUCCESS' && Date.parse(fulfillment.createdAt) >= Math.floor(Date.parse(startedAt) / 1000) * 1000 && exactLines(fulfillment.fulfillmentLineItems, expected) && fulfillment.trackingInfo?.some(item => item.company === trackingInfo.company && item.number === trackingInfo.number && (!trackingInfo.url || item.url === trackingInfo.url));
}
export function createFulfillmentService({ shop, client, repository, allowedLocationIds = [], writesEnabled = false, now = Date.now } = {}) {
  normalizeShop(shop);
  for (const name of ['withOrderLock', 'getQuote', 'saveQuote', 'getOperation', 'saveOperation']) if (typeof repository?.[name] !== 'function') throw new Error(`Fulfillment repository requires ${name}`);
  if (!client?.request) throw new Error('Authenticated fulfillment client is required');
  const locations = new Set(allowedLocationIds.map(value => gid(value, 'Location')));
  async function read(id) {
    const data = await client.request(FULFILLMENT_GRAPHQL.order, { id });
    if (data?.shop?.myshopifyDomain !== shop || data.order?.id !== id) throw new Error('Order is unavailable in the verified store');
    if (data.order.fulfillmentOrders?.pageInfo?.hasNextPage || !Array.isArray(data.order.fulfillmentOrders?.nodes) || !Array.isArray(data.order.fulfillments) || data.order.fulfillments.length >= 100) throw new Error('Fulfillment data requires additional native review');
    return data.order;
  }
  async function assertReady(order) {
    const quote = await repository.getQuote(order.id);
    if (order.cancelledAt || order.closed || order.displayFinancialStatus !== 'PAID' || quote?.status !== 'paid' || quote.shop !== shop || quote.orderId !== order.id) throw new Error('Verified native and central paid status is required before shipment');
    if (order.totalOutstandingSet?.shopMoney?.currencyCode !== 'USD' || decimalMoney(order.totalOutstandingSet.shopMoney.amount, { zero: true }) !== '0.00' || order.currentTotalPriceSet?.shopMoney?.currencyCode !== 'USD' || decimalMoney(order.currentTotalPriceSet.shopMoney.amount) !== quote.nativeMoney.total) throw new Error('Shipment order money changed');
    if (quote.pendingFulfillmentOperationKey) throw new Error('A previous shipment is unresolved; reconcile its original journal');
    return quote;
  }
  async function save(op) { await repository.saveOperation(op.key, { ...op, updatedAt: new Date(now()).toISOString() }); }
  async function fulfill(input) {
    if (writesEnabled !== true) throw new Error('Shopify fulfillment writes are disabled');
    const id = paymentOrderId(input.orderId), key = operationKey(input.operationKey), lines = normalizedLines(input.lines), trackingInfo = tracking(input.trackingInfo);
    if (input.actualShippedConfirmed !== true) throw new Error('Independently confirm the actual shipment before native fulfillment');
    const inputHash = createHash('sha256').update(JSON.stringify({ lines, trackingInfo })).digest('hex');
    return repository.withOrderLock(id, async () => {
      await repository.assertOrderOperable?.(id);
      const prior = await repository.getOperation(key);
      if (prior) {
        if (prior.kind !== 'fulfillment' || prior.shop !== shop || prior.orderId !== id || prior.inputHash !== inputHash) throw new Error('Shipment operation key belongs to another intent');
        if (prior.status === 'complete') return { alreadyComplete: true, fulfillmentId: prior.fulfillmentId };
        throw new Error('Shipment outcome is unresolved; inspect the original journal before retrying');
      }
      const order = await read(id); const quote = await assertReady(order);
      if (!locations.size) throw new Error('Verified merchant fulfillment locations are not configured');
      const grouped = new Map(), expected = new Map(), selectedLocations = new Set();
      for (const line of lines) {
        const fulfillmentOrder = order.fulfillmentOrders.nodes.find(fo => fo.id === line.fulfillmentOrderId);
        if (!fulfillmentOrder || !['OPEN', 'IN_PROGRESS'].includes(fulfillmentOrder.status) || fulfillmentOrder.lineItems?.pageInfo?.hasNextPage || !locations.has(fulfillmentOrder.assignedLocation?.location?.id)) throw new Error('Fulfillment order is unavailable at a verified merchant location');
        selectedLocations.add(fulfillmentOrder.assignedLocation.location.id);
        const nativeLine = fulfillmentOrder.lineItems.nodes.find(item => item.id === line.id);
        if (!nativeLine || nativeLine.remainingQuantity < line.quantity || !nativeLine.lineItem?.id) throw new Error('Actual shipped quantity exceeds the current native unfulfilled quantity');
        const list = grouped.get(line.fulfillmentOrderId) || []; list.push({ id: line.id, quantity: line.quantity }); grouped.set(line.fulfillmentOrderId, list);
        expected.set(nativeLine.lineItem.id, (expected.get(nativeLine.lineItem.id) || 0) + line.quantity);
      }
      if (selectedLocations.size !== 1) throw new Error('One shipment cannot combine different merchant locations');
      const expectedLines = [...expected].map(([id, quantity]) => ({ id, quantity })).sort((a, b) => a.id.localeCompare(b.id));
      const fulfillment = { lineItemsByFulfillmentOrder: [...grouped].map(([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({ fulfillmentOrderId, fulfillmentOrderLineItems })), notifyCustomer: false, trackingInfo };
      const op = { key, kind: 'fulfillment', shop, orderId: id, inputHash, fulfillment, expectedLines, knownFulfillmentIds: order.fulfillments.map(item => item.id), status: 'prepared', startedAt: new Date(now()).toISOString() }; await save(op);
      await repository.saveQuote(id, { ...quote, pendingFulfillmentOperationKey: key });
      op.status = 'in-flight'; await save(op);
      let payload;
      try { payload = (await client.request(FULFILLMENT_GRAPHQL.create, { fulfillment }, { safeRetry: false })).fulfillmentCreate; }
      catch { op.status = 'unknown'; await save(op); throw new Error('Shipment outcome is unknown; automatic replay is frozen'); }
      if (!payload || !Array.isArray(payload.userErrors)) { op.status = 'unknown'; await save(op); throw new Error('Shipment response is incomplete; automatic replay is frozen'); }
      if (payload.userErrors.length) { op.status = 'rejected'; await save(op); throw new Error('Native fulfillment was rejected'); }
      op.fulfillmentId = payload.fulfillment?.id; await save(op);
      const after = await read(id); const actual = after.fulfillments.find(f => f.id === op.fulfillmentId);
      if (op.knownFulfillmentIds.includes(actual?.id) || !matches(actual, expectedLines, trackingInfo, op.startedAt)) { op.status = 'readback-mismatch'; await save(op); throw new Error('Native shipment is not verified'); }
      await repository.saveQuote(id, { ...(await repository.getQuote(id)), pendingFulfillmentOperationKey: null });
      op.status = 'complete'; await save(op);
      return { fulfillmentId: actual.id, nativeVerified: true, customerNotified: false };
    });
  }
  async function reconcile(operation) {
    if (writesEnabled !== true) throw new Error('Shopify fulfillment writes are disabled');
    const key = operationKey(operation), prior = await repository.getOperation(key);
    if (!prior || prior.kind !== 'fulfillment' || prior.shop !== shop || !['unknown', 'in-flight', 'readback-mismatch'].includes(prior.status)) throw new Error('An unresolved shipment intent is required');
    return repository.withOrderLock(prior.orderId, async () => {
      await repository.assertOrderOperable?.(prior.orderId);
      const order = await read(prior.orderId);
      const quote = await repository.getQuote(prior.orderId);
      if (!quote || (quote.pendingFulfillmentOperationKey !== key && quote.pendingFulfillmentOperationKey)) throw new Error('Original pending shipment journal changed');
      const actual = order.fulfillments.filter(f => !prior.knownFulfillmentIds.includes(f.id) && (!prior.fulfillmentId || prior.fulfillmentId === f.id) && matches(f, prior.expectedLines, prior.fulfillment.trackingInfo, prior.startedAt));
      if (!actual.length) return { unresolved: true, replayed: false };
      if (actual.length !== 1) throw new Error('Ambiguous native shipment; manual reconciliation is required');
      await repository.saveQuote(prior.orderId, { ...quote, pendingFulfillmentOperationKey: null });
      prior.fulfillmentId = actual[0].id; prior.status = 'complete'; await save(prior);
      return { fulfillmentId: prior.fulfillmentId, nativeVerified: true, replayed: false };
    });
  }
  return Object.freeze({ fulfill, reconcile });
}
