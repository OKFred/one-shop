import { createHash } from 'node:crypto';
import { normalizeShop } from './config.js';
import { integer } from './inventory.js';

const operationalFields = `id name updatedAt currencyCode presentmentCurrencyCode cancelledAt closed capturable displayFinancialStatus displayFulfillmentStatus
  currentTotalPriceSet{shopMoney{amount currencyCode}} totalOutstandingSet{shopMoney{amount currencyCode}} totalReceivedSet{shopMoney{amount currencyCode}}
  transactions(first:100){id kind status manualPaymentGateway paymentDetails{__typename}}
  lineItems(first:100){pageInfo{hasNextPage} nodes{id sku quantity currentQuantity}}
  refunds{id refundLineItems(first:100){pageInfo{hasNextPage} nodes{id quantity restockType restocked lineItem{id}}}}
  fulfillments(first:100){id status}
  fulfillmentOrders(first:100){pageInfo{hasNextPage} nodes{id status assignedLocation{location{id isActive updatedAt deactivatedAt}}
    lineItems(first:100){pageInfo{hasNextPage} nodes{remainingQuantity lineItem{id}}}}}`;
export const CANCELLATION_GRAPHQL = Object.freeze({
  order: `query BridgeCancellationOrder($id:ID!){shop{myshopifyDomain} order(id:$id){${operationalFields}}}`,
  cancel: `mutation BridgeManualCancellation($orderId:ID!,$reason:OrderCancelReason!){
    orderCancel(orderId:$orderId,reason:$reason,notifyCustomer:false,refundMethod:{originalPaymentMethodsRefund:false},restock:true){
      orderCancelUserErrors{code field} jobResult{id done status errors{code field} order{id}}
    }
  }`,
  job: `query BridgeCancellationJob($id:ID!){node(id:$id){... on OrderCancelJobResult{id done status errors{code field} order{id}}}}`,
  locations: `query BridgeCancellationLocations($ids:[ID!]!){nodes(ids:$ids){... on Location{id isActive updatedAt deactivatedAt}}}`
});
function orderId(value) { if (typeof value !== 'string' || !/^gid:\/\/shopify\/Order\/[0-9]+$/.test(value)) throw new Error('Invalid native order identity'); return value; }
function operation(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(value)) throw new Error('A stable cancellation operation key is required'); return value; }
function usd(bag) {
  const value = bag?.shopMoney;
  if (value?.currencyCode !== 'USD' || typeof value.amount !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value.amount)) throw new Error('Exact native USD order money is required');
  const [whole, fraction = ''] = value.amount.split('.'); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
function linesOf(order) {
  const lines = order.lineItems;
  if (!Array.isArray(lines?.nodes) || !lines.nodes.length || lines.nodes.length >= 100 || lines.pageInfo?.hasNextPage) throw new Error('Complete bounded native line quantities are required');
  const seen = new Set();
  return lines.nodes.map((line) => {
    if (!/^gid:\/\/shopify\/LineItem\/[0-9]+$/.test(line.id || '') || seen.has(line.id) || typeof line.sku !== 'string' || !line.sku) throw new Error('Ambiguous native cancellation line');
    seen.add(line.id); const quantity = integer(line.quantity); const currentQuantity = integer(line.currentQuantity);
    if (quantity <= 0 || currentQuantity !== quantity) throw new Error('Edited or previously released lines require native manual review');
    return { id: line.id, sku: line.sku, quantity, currentQuantity };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function unpaidManual(order) {
  if (order.currencyCode !== 'USD' || order.presentmentCurrencyCode !== 'USD' || order.cancelledAt || order.closed || order.capturable || order.displayFinancialStatus !== 'PENDING' ||
      !Array.isArray(order.transactions) || !order.transactions.length || order.transactions.length >= 100 ||
      order.transactions.some((transaction) => transaction.manualPaymentGateway !== true || transaction.paymentDetails || transaction.kind !== 'SALE' || transaction.status !== 'PENDING') ||
      !Array.isArray(order.refunds) || order.refunds.length || !Array.isArray(order.fulfillments) || order.fulfillments.length ||
      usd(order.totalReceivedSet) !== 0n || usd(order.currentTotalPriceSet) !== usd(order.totalOutstandingSet)) {
    throw new Error('Only untouched unpaid manual-payment orders can use this cancellation flow');
  }
}

/** DI service. Generic orderCancel is never automatically replayed after an unknown response. */
export function createCancellationService({ shop, client, mappingStore, quoteRepository = null, approvedLocationIds = [],
  observeOrder, assertMappedLines, freezeCapacity, writesEnabled = false, now = Date.now } = {}) {
  normalizeShop(shop);
  if (!client?.request || !mappingStore?.withLock || !mappingStore?.getOperation || !mappingStore?.saveOperation ||
      typeof observeOrder !== 'function' || typeof assertMappedLines !== 'function' || typeof freezeCapacity !== 'function') throw new Error('Private cancellation adapters are required');
  const locations = new Set(approvedLocationIds);
  if ([...locations].some((id) => !/^gid:\/\/shopify\/Location\/[0-9]+$/.test(id))) throw new Error('Invalid approved restock location');
  if (quoteRepository && ['withOrderLock','getQuote','saveQuote','listReceipts'].some((name) => typeof quoteRepository[name] !== 'function')) throw new Error('Cancellation quote repository is incomplete');
  const keyFor = (id) => `order-restock:${id}`;
  const save = (record) => mappingStore.saveOperation(keyFor(record.orderId), { ...record, updatedAt: new Date(now()).toISOString() });
  function locationBasis(location) {
    if (!locations.has(location?.id) || location.isActive !== true || typeof location.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(location.updatedAt)) || (location.deactivatedAt != null && typeof location.deactivatedAt !== 'string')) {
      throw new Error('Restock requires unchanged reviewed active location facts');
    }
    return { id: location.id, updatedAt: location.updatedAt, deactivatedAt: location.deactivatedAt ?? null };
  }
  async function read(id) {
    const data = await client.request(CANCELLATION_GRAPHQL.order, { id });
    if (data.shop?.myshopifyDomain !== shop || data.order?.id !== id) throw new Error('Order ownership in the configured store is required');
    return data.order;
  }
  async function quoteBefore(id, key) {
    if (!quoteRepository) return;
    if ((await quoteRepository.listReceipts(`${shop}:${id}`)).length) throw new Error('An order with independently recorded receipts needs merchant financial review');
    const quote = await quoteRepository.getQuote(id);
    if (!quote) return;
    if (['partial','received','paid'].includes(quote.status) || quote.pendingOperationKey || quote.pendingPaymentOperationKey || quote.pendingFulfillmentOperationKey) throw new Error('A received or unresolved quote cannot be canceled here');
    if (quote.cancelIntent === key && quote.status === 'inactive') return;
    await quoteRepository.saveQuote(id, { ...quote, status: 'inactive', paymentVersion: quote.paymentVersion + 1,
      wisePaymentUrl: null, cancelIntent: key });
  }
  async function settle(record) {
    if (record.status === 'complete') { await observeOrder(await read(record.orderId), { restockEvidence: record.restockEvidence }); return { status: 'complete', alreadyComplete: true, replayed: false }; }
    if (!record.jobResultId) {
      // The first freeze may itself have failed during the response-loss crash.
      // Retrying this durable unknown intent must restore the guard, never resend.
      await freezeCapacity(record.before.lines);
      return { status: 'unknown', requiresMerchantReview: true, replayed: false };
    }
    let job;
    for (let attempt = 0; attempt < 3; attempt++) {
      job = (await client.request(CANCELLATION_GRAPHQL.job, { id: record.jobResultId })).node;
      if (!job || job.id !== record.jobResultId || job.order?.id !== record.orderId || !Array.isArray(job.errors)) throw new Error('Original native cancellation job identity differs');
      if (job.done) break;
    }
    if (!job.done) return { status: 'pending', replayed: false };
    if (job.status !== 'SUCCEEDED' || job.errors.length) { record.status = 'review'; await save(record); await freezeCapacity(record.before.lines); throw new Error('Native cancellation job did not prove successful completion'); }
    const current = await read(record.orderId);
    const active = await client.request(CANCELLATION_GRAPHQL.locations, { ids: record.before.locations });
    if (!Array.isArray(active.nodes) || active.nodes.length !== record.before.locations.length ||
        record.before.locationVersions?.length !== record.before.locations.length ||
        record.before.locationVersions.some((basis) => !active.nodes.some((node) => node?.id === basis.id && node.isActive === true &&
          node.updatedAt === basis.updatedAt && (node.deactivatedAt ?? null) === basis.deactivatedAt)) ||
        !current.cancelledAt || current.currencyCode !== 'USD' || current.presentmentCurrencyCode !== 'USD' ||
        JSON.stringify(linesOf(current)) !== JSON.stringify(record.before.lines) || usd(current.totalReceivedSet) !== 0n) {
      record.status = 'review'; await save(record); await freezeCapacity(record.before.lines); throw new Error('Canceled order lines, money or active restock locations require review');
    }
    record.status = 'complete'; record.completedAt = new Date(now()).toISOString();
    record.restockEvidence = Object.fromEntries(record.before.lines.map((line) => [line.id, line.quantity]));
    // This proof must be durable before a webhook or gap-fill can consume it.
    await save(record); await observeOrder(current, { restockEvidence: record.restockEvidence });
    return { status: 'complete', nativeVerified: true, customerNotified: false, refunded: false, replayed: false };
  }
  async function locked(id, work) {
    const run = () => mappingStore.withLock(`order-cancel:${shop}:${id}`, work);
    return quoteRepository ? quoteRepository.withOrderLock(id, run) : run();
  }
  async function cancel(input) {
    if (!writesEnabled) throw new Error('Native cancellation writes are disabled');
    const id = orderId(input.orderId); const operationKey = operation(input.operationKey);
    if (input.merchantConfirmed !== true || !['CUSTOMER','INVENTORY','OTHER'].includes(input.reason)) throw new Error('Explicit merchant cancellation and reason are required');
    const request = { orderId: id, reason: input.reason, notifyCustomer: false, refundMethod: { originalPaymentMethodsRefund: false }, restock: true };
    const inputHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return locked(id, async () => {
      const previous = await mappingStore.getOperation(keyFor(id));
      if (previous) {
        if (previous.kind !== 'order-cancel' || previous.shop !== shop || previous.operationKey !== operationKey || previous.inputHash !== inputHash) throw new Error('Order cancellation is bound to its original merchant intent');
        if (previous.status !== 'prepared') return settle(previous);
      }
      const order = await read(id); unpaidManual(order); const lines = linesOf(order);
      if (!locations.size || order.fulfillmentOrders?.pageInfo?.hasNextPage || !Array.isArray(order.fulfillmentOrders?.nodes) || !order.fulfillmentOrders.nodes.length || order.fulfillmentOrders.nodes.length >= 100) throw new Error('Complete approved fulfillment allocation is required');
      const allocated = new Map(); const assigned = new Map();
      for (const fulfillment of order.fulfillmentOrders.nodes) {
        const location = fulfillment.assignedLocation?.location;
        if (fulfillment.status !== 'OPEN' || !locations.has(location?.id) || location.isActive !== true || fulfillment.lineItems?.pageInfo?.hasNextPage || !Array.isArray(fulfillment.lineItems?.nodes) || fulfillment.lineItems.nodes.length >= 100) throw new Error('Restock allocation must be open at an approved active location');
        const basis = locationBasis(location);
        if (assigned.has(location.id) && JSON.stringify(assigned.get(location.id)) !== JSON.stringify(basis)) throw new Error('Restock location facts changed during allocation read');
        assigned.set(location.id, basis);
        for (const line of fulfillment.lineItems.nodes) allocated.set(line.lineItem?.id, integer((allocated.get(line.lineItem?.id) ?? 0) + integer(line.remainingQuantity)));
      }
      if (allocated.size !== lines.length || lines.some((line) => allocated.get(line.id) !== line.quantity)) throw new Error('Unfulfilled native allocation differs from the cancellation basis');
      await assertMappedLines(lines); await quoteBefore(id, keyFor(id)); await observeOrder(order, {});
      const before = { lines, locations: [...assigned.keys()].sort(), locationVersions: [...assigned.values()].sort((a, b) => a.id.localeCompare(b.id)), sourceUpdatedAt: order.updatedAt };
      if (previous && JSON.stringify(previous.before) !== JSON.stringify(before)) throw new Error('Prepared native cancellation basis changed');
      const record = previous || { kind: 'order-cancel', shop, orderId: id, operationKey, merchantConfirmed: true,
        input: request, inputHash, before, status: 'prepared', startedAt: new Date(now()).toISOString() };
      await save(record); record.status = 'in-flight'; await save(record);
      let payload;
      try { payload = (await client.request(CANCELLATION_GRAPHQL.cancel, { orderId: id, reason: input.reason }, { kind: 'mutation', safeRetry: false })).orderCancel; }
      catch { record.status = 'unknown'; await save(record); await freezeCapacity(lines); return { status: 'unknown', requiresMerchantReview: true, replayed: false }; }
      if (!payload || !Array.isArray(payload.orderCancelUserErrors) || payload.orderCancelUserErrors.length || !payload.jobResult?.id) {
        record.status = 'review'; await save(record); await freezeCapacity(lines); throw new Error('Native cancellation response requires investigation');
      }
      record.jobResultId = payload.jobResult.id; record.status = 'pending'; await save(record);
      return settle(record);
    });
  }
  async function reconcile(input) {
    if (!writesEnabled) throw new Error('Native cancellation writes are disabled');
    const id = orderId(input.orderId); const operationKey = operation(input.operationKey);
    return locked(id, async () => {
      const record = await mappingStore.getOperation(keyFor(id));
      if (!record || record.kind !== 'order-cancel' || record.shop !== shop || record.operationKey !== operationKey) throw new Error('Original private cancellation intent is required');
      return settle(record);
    });
  }
  return Object.freeze({ cancel, reconcile });
}
