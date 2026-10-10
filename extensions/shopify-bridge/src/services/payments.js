import { createHash } from 'node:crypto';
import { normalizeShop } from './config.js';

const bagFields = 'shopMoney { amount currencyCode } presentmentMoney { amount currencyCode }';
export const PAYMENT_ORDER_FIELDS = `id legacyResourceId customer { id } cancelledAt closed currencyCode presentmentCurrencyCode displayFinancialStatus canMarkAsPaid capturable paymentGatewayNames
  currentTotalPriceSet { ${bagFields} } currentSubtotalPriceSet { ${bagFields} } currentShippingPriceSet { ${bagFields} } currentTotalTaxSet { ${bagFields} } currentTotalDiscountsSet { ${bagFields} } totalOutstandingSet { ${bagFields} } totalReceivedSet { ${bagFields} }
  transactions(first: 100) { id kind status gateway manualPaymentGateway paymentDetails { __typename } }`;
const calculatedFields = `id subtotalPriceSet { ${bagFields} } totalPriceSet { ${bagFields} } totalOutstandingSet { ${bagFields} } taxLines { priceSet { ${bagFields} } } shippingLines { id title stagedStatus price { ${bagFields} } }`;
export const PAYMENT_GRAPHQL = Object.freeze({
  order: `query ShushaPaymentOrder($id: ID!) { shop { myshopifyDomain } order(id: $id) { ${PAYMENT_ORDER_FIELDS} } }`,
  begin: `mutation ShushaQuoteBegin($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { ${calculatedFields} } userErrors { field message } } }`,
  update: `mutation ShushaQuoteShippingUpdate($id: ID!, $shippingLineId: ID!, $shippingLine: OrderEditUpdateShippingLineInput!) { orderEditUpdateShippingLine(id: $id, shippingLineId: $shippingLineId, shippingLine: $shippingLine) { calculatedOrder { ${calculatedFields} } userErrors { field message } } }`,
  remove: `mutation ShushaQuoteShippingRemove($id: ID!, $shippingLineId: ID!) { orderEditRemoveShippingLine(id: $id, shippingLineId: $shippingLineId) { calculatedOrder { ${calculatedFields} } userErrors { field message } } }`,
  add: `mutation ShushaQuoteShippingAdd($id: ID!, $shippingLine: OrderEditAddShippingLineInput!) { orderEditAddShippingLine(id: $id, shippingLine: $shippingLine) { calculatedOrder { ${calculatedFields} } userErrors { field message } } }`,
  commit: `mutation ShushaQuoteCommit($id: ID!) { orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Manual shipping quote confirmed; no automatic payment request") { order { id } userErrors { field message } } }`,
  paid: `mutation ShushaManualPaid($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id displayFinancialStatus totalOutstandingSet { ${bagFields} } } userErrors { field message } } }`
});

export function paymentOrderId(value) { if (typeof value !== 'string' || !/^gid:\/\/shopify\/Order\/\d+$/.test(value)) throw new Error('Invalid Shopify order identity'); return value; }
export function operationKey(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(value)) throw new Error('A stable private operation key is required'); return value; }
export function decimalMoney(value, { zero = false } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) throw new Error('Amount must be an exact decimal with at most two places');
  const [whole, fraction = ''] = value.split('.'); const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if ((!zero && cents === 0n) || cents > 999999999999n) throw new Error('Unsupported payment amount');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
export function moneyCents(value) { return BigInt(decimalMoney(value, { zero: true }).replace('.', '')); }
export function centsMoney(value) { if (value < 0n) throw new Error('Negative payment amount'); return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }
export function normalizedReceiptReference(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._/:-]{2,119}$/.test(value.trim())) throw new Error('Actual bank receipt reference is required');
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function safeTitle(value) { if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('Shipping title is required'); return value.trim(); }
function bag(value) {
  if (value?.shopMoney?.currencyCode !== 'USD' || value?.presentmentMoney?.currencyCode !== 'USD') throw new Error('This quote flow supports native and presentment USD only');
  const shop = decimalMoney(value.shopMoney.amount, { zero: true }); const presentment = decimalMoney(value.presentmentMoney.amount, { zero: true });
  if (shop !== presentment) throw new Error('Native and presentment money differ');
  return shop;
}
export function readOrderMoney(order) {
  return { currency: 'USD', total: bag(order.currentTotalPriceSet), subtotal: bag(order.currentSubtotalPriceSet), shipping: bag(order.currentShippingPriceSet), tax: bag(order.currentTotalTaxSet), discounts: bag(order.currentTotalDiscountsSet), outstanding: bag(order.totalOutstandingSet), receivedNative: bag(order.totalReceivedSet) };
}
export function assertManualOrder(order, allowedManualGateways) {
  paymentOrderId(order?.id);
  if (order.cancelledAt || order.closed || order.currencyCode !== 'USD' || order.presentmentCurrencyCode !== 'USD') throw new Error('Order is cancelled, closed or outside the USD manual flow');
  const allowed = new Set((allowedManualGateways || []).map(s => String(s).trim().toLowerCase()));
  if (!allowed.size || !Array.isArray(order.paymentGatewayNames) || !order.paymentGatewayNames.length || order.paymentGatewayNames.some(g => !allowed.has(String(g).trim().toLowerCase()))) throw new Error('Order is not using a verified manual payment gateway');
  if (order.capturable || order.displayFinancialStatus === 'AUTHORIZED' || !Array.isArray(order.transactions) || order.transactions.length >= 100) throw new Error('Card authorization or incomplete transactions require native manual review');
  for (const tx of order.transactions) {
    if (tx.paymentDetails || tx.manualPaymentGateway !== true || !allowed.has(String(tx.gateway).trim().toLowerCase()) || ['AUTHORIZATION', 'CAPTURE'].includes(tx.kind)) throw new Error('Online payment or card authorization must not be captured by this flow');
  }
  return readOrderMoney(order);
}
export function assertQuoteMatchesCurrent(quote, order, { shop, allowedManualGateways } = {}) {
  if (!quote || quote.shop !== normalizeShop(shop) || quote.orderId !== order?.id || !['confirmed', 'partial', 'received'].includes(quote.status) || !Number.isSafeInteger(quote.revision) || quote.revision < 1) throw new Error('There is no active payment quote');
  const money = assertManualOrder(order, allowedManualGateways);
  if (!['PENDING', 'PARTIALLY_PAID'].includes(order.displayFinancialStatus) || !order.canMarkAsPaid || money.outstanding === '0.00') throw new Error('Order is not awaiting manual payment');
  if (!quote.nativeMoney || Object.keys(money).some(key => money[key] !== quote.nativeMoney[key])) throw new Error('Native order amount changed; reconfirm the quote');
  return money;
}

export async function readLivePaymentOrder(client, shop, id) {
  paymentOrderId(id);
  const data = await client.request(PAYMENT_GRAPHQL.order, { id });
  if (data?.shop?.myshopifyDomain !== normalizeShop(shop) || data.order?.id !== id) throw new Error('Shopify order is unavailable in the verified store');
  return data.order;
}
export function privateReceivingDetails(config, { amount, reference }) {
  if (config?.verified !== true || !Array.isArray(config.bankDetails) || !config.bankDetails.length) throw new Error('Verified business receiving configuration is required');
  const bankDetails = config.bankDetails.map(field => {
    if (typeof field.label !== 'string' || typeof field.value !== 'string' || !field.label.trim() || !field.value.trim() || field.label.length > 100 || field.value.length > 500 || /[\p{Cc}\p{Cf}]/u.test(field.label + field.value)) throw new Error('Invalid private bank field');
    return { label: field.label, value: field.value };
  });
  let wisePaymentUrl = null;
  if (config.wiseBusinessOpenLink) {
    const url = new URL(config.wiseBusinessOpenLink);
    if (url.origin !== 'https://wise.com' || url.username || url.password || url.search || url.hash || !/^\/pay\/business\/[A-Za-z0-9._~-]+\/?$/.test(url.pathname)) throw new Error('Verified Wise business receiving link is required');
    if (moneyCents(amount) > 0n) { url.search = new URLSearchParams({ amount: decimalMoney(amount), currency: 'USD', description: reference }).toString(); wisePaymentUrl = url.href; }
  }
  return { bankDetails, wisePaymentUrl };
}

export function createPaymentService({ shop, client, repository, receivingConfig, allowedManualGateways = [], writesEnabled = false, now = Date.now } = {}) {
  normalizeShop(shop);
  for (const name of ['withOrderLock', 'getQuote', 'saveQuote', 'getOperation', 'saveOperation', 'getReceipt', 'claimReceipt', 'listReceipts']) if (typeof repository?.[name] !== 'function') throw new Error(`Payment repository requires ${name}`);
  if (typeof client?.request !== 'function') throw new Error('Authenticated Admin client is required');
  const orderKey = id => `${shop}:${id}`;
  function enabled() { if (writesEnabled !== true) throw new Error('Shopify payment writes are disabled'); }
  async function receiving() { return typeof receivingConfig === 'function' ? receivingConfig() : receivingConfig; }
  async function saveOperation(op) { await repository.saveOperation(op.key, { ...op, updatedAt: new Date(now()).toISOString() }); }
  async function mutate(op, stage, operation, variables, payloadName) {
    op.stage = stage; op.status = 'in-flight'; op.request = { operation, variables }; await saveOperation(op);
    let result;
    try { result = await client.request(PAYMENT_GRAPHQL[operation], variables, { safeRetry: false }); }
    catch (error) { op.status = error.code === 'SHOPIFY_AUTHORIZATION' || error.code === 'SHOPIFY_HTTP_REJECTED' || (error.code === 'SHOPIFY_GRAPHQL_ERROR' && error.codes?.every(c => ['GRAPHQL_VALIDATION_FAILED', 'ACCESS_DENIED', 'MAX_COST_EXCEEDED'].includes(c))) ? 'rejected' : 'unknown'; await saveOperation(op); throw new Error(op.status === 'unknown' ? 'Payment operation outcome is unknown; automatic replay is frozen' : 'Shopify rejected the payment operation'); }
    const payload = result?.[payloadName];
    if (!payload || !Array.isArray(payload.userErrors)) { op.status = 'unknown'; await saveOperation(op); throw new Error('Payment operation response is incomplete; automatic replay is frozen'); }
    if (payload.userErrors.length) { op.status = 'rejected'; await saveOperation(op); throw new Error('Shopify rejected the payment operation'); }
    op.status = 'staged'; await saveOperation(op); return payload;
  }
  async function checkOperation(key, kind, id, input) {
    const prior = await repository.getOperation(key);
    if (prior && (prior.kind !== kind || prior.shop !== shop || prior.orderId !== id || prior.inputHash !== digest(input))) throw new Error('Operation key belongs to another payment intent');
    if (prior && prior.status !== 'complete') throw new Error('Previous payment intent is unresolved; review its journal before retrying');
    return prior;
  }
  async function receiptsTotal(id, revision) {
    const receipts = await repository.listReceipts(orderKey(id));
    let sum = 0n;
    for (const receipt of receipts) {
      if (receipt.platform !== 'shopify' || receipt.orderKey !== orderKey(id) || receipt.currency !== 'USD' || receipt.quoteRevision !== revision) throw new Error('Receipt ledger does not match the active quote');
      sum += moneyCents(decimalMoney(receipt.amount));
    }
    return sum;
  }
  async function confirmShippingQuote(input) {
    enabled(); const id = paymentOrderId(input.orderId); const key = operationKey(input.operationKey);
    const shippingAmount = decimalMoney(input.shippingAmount, { zero: true }); const shippingTitle = safeTitle(input.shippingTitle);
    if (input.merchantAvailabilityConfirmed !== true || !Number.isSafeInteger(input.expectedQuoteRevision) || input.expectedQuoteRevision < 0) throw new Error('Confirm actual availability and the current quote revision');
    const intent = { shippingAmount, shippingTitle, expectedQuoteRevision: input.expectedQuoteRevision };
    return repository.withOrderLock(id, async () => {
      await repository.assertOrderOperable?.(id);
      const prior = await checkOperation(key, 'quote', id, intent);
      if (prior) return { alreadyComplete: true, quote: await repository.getQuote(id) };
      const previous = await repository.getQuote(id);
      if ((previous?.revision || 0) !== input.expectedQuoteRevision) throw new Error('Quote revision changed');
      if (previous && ['paid', 'received', 'partial'].includes(previous.status)) throw new Error('An order with received funds cannot be requoted automatically');
      if (previous?.pendingOperationKey) throw new Error('A previous shipping edit is unresolved');
      const beforeOrder = await readLivePaymentOrder(client, shop, id); const before = assertManualOrder(beforeOrder, allowedManualGateways);
      if (beforeOrder.displayFinancialStatus !== 'PENDING' || before.receivedNative !== '0.00' || before.outstanding !== before.total) throw new Error('Shipping edits require an unpaid manual order');
      if ((await repository.listReceipts(orderKey(id))).length) throw new Error('Received funds require manual reconciliation before changing shipping');
      const config = await receiving(); privateReceivingDetails(config, { amount: before.total, reference: 'SHUSHA-QUOTE-VALIDATION' });
      const revision = (previous?.revision || 0) + 1;
      const op = { key, kind: 'quote', orderId: id, shop, inputHash: digest(intent), input: intent, status: 'prepared', stage: 'intent', revision, before, startedAt: new Date(now()).toISOString() };
      await saveOperation(op);
      // Durable invalidation happens before even orderEditBegin. A crashed or
      // unknown edit leaves no old payment credential usable.
      await repository.saveQuote(id, { ...(previous || {}), shop, orderId: id, revision: previous?.revision || 0, paymentVersion: (previous?.paymentVersion || 0) + 1, status: 'inactive', pendingOperationKey: key });
      const begin = await mutate(op, 'begin', 'begin', { id }, 'orderEditBegin');
      let calculated = begin.calculatedOrder;
      if (!/^gid:\/\/shopify\/CalculatedOrder\//.test(calculated?.id || '') || !Array.isArray(calculated.shippingLines) || calculated.shippingLines.length > 100) { op.status = 'unknown'; await saveOperation(op); throw new Error('Incomplete calculated order; shipping quote remains inactive'); }
      op.calculatedOrderId = calculated.id; await saveOperation(op);
      const line = { title: shippingTitle, price: { amount: shippingAmount, currencyCode: 'USD' } };
      const existing = calculated.shippingLines.filter(l => l.stagedStatus !== 'REMOVED');
      if (existing.length === 1 && existing[0].stagedStatus === 'ADDED') {
        calculated = (await mutate(op, 'shipping-update', 'update', { id: calculated.id, shippingLineId: existing[0].id, shippingLine: line }, 'orderEditUpdateShippingLine')).calculatedOrder;
      } else {
        for (let index = 0; index < existing.length; index++) await mutate(op, `shipping-remove-${index}`, 'remove', { id: op.calculatedOrderId, shippingLineId: existing[index].id }, 'orderEditRemoveShippingLine');
        calculated = (await mutate(op, 'shipping-add', 'add', { id: op.calculatedOrderId, shippingLine: line }, 'orderEditAddShippingLine')).calculatedOrder;
      }
      if (!calculated || bag(calculated.subtotalPriceSet) !== before.subtotal) throw new Error('Calculated merchandise changed; shipping quote remains inactive');
      if (!Array.isArray(calculated.taxLines)) throw new Error('Calculated tax readback is incomplete');
      const calculatedTotal = bag(calculated.totalPriceSet); const calculatedTax = centsMoney(calculated.taxLines.reduce((sum, line) => sum + moneyCents(bag(line.priceSet)), 0n)); const calculatedOutstanding = bag(calculated.totalOutstandingSet);
      const beforeCommit = assertManualOrder(await readLivePaymentOrder(client, shop, id), allowedManualGateways);
      if (Object.keys(before).some(field => before[field] !== beforeCommit[field])) throw new Error('Native order changed while preparing shipping; quote remains inactive');
      const committed = await mutate(op, 'commit', 'commit', { id: op.calculatedOrderId }, 'orderEditCommit');
      if (committed.order?.id !== id) { op.status = 'unknown'; await saveOperation(op); throw new Error('Committed order identity differs; automatic replay is frozen'); }
      const afterOrder = await readLivePaymentOrder(client, shop, id); const actual = assertManualOrder(afterOrder, allowedManualGateways);
      if (afterOrder.displayFinancialStatus !== 'PENDING' || actual.subtotal !== before.subtotal || actual.discounts !== before.discounts || actual.shipping !== shippingAmount || actual.receivedNative !== '0.00' || actual.total !== calculatedTotal || actual.tax !== calculatedTax || actual.outstanding !== calculatedOutstanding || actual.outstanding !== actual.total) { op.status = 'readback-mismatch'; await saveOperation(op); throw new Error('Native shipping, tax or total readback differs; quote remains inactive'); }
      const reference = `SHUSHA-S-${String(afterOrder.legacyResourceId)}`;
      if (!/^SHUSHA-S-\d+$/.test(reference)) throw new Error('Native order reference is unavailable');
      const quote = { shop, orderId: id, revision, paymentVersion: (previous?.paymentVersion || 0) + 2, status: 'confirmed', currency: 'USD', amount: actual.outstanding, receivedAmount: '0.00', remainingAmount: actual.outstanding, nativeMoney: actual, shippingTitle, shippingAmount, reference, receivingConfig: { verified: true, bankDetails: config.bankDetails, wiseBusinessOpenLink: config.wiseBusinessOpenLink || null }, ...privateReceivingDetails(config, { amount: actual.outstanding, reference }), confirmedAt: new Date(now()).toISOString(), pendingOperationKey: null };
      await repository.saveQuote(id, quote); op.status = 'complete'; op.stage = 'verified'; await saveOperation(op);
      return { quote, nativeVerified: true, customerNotified: false };
    });
  }
  async function recordReceipt(input) {
    enabled(); const id = paymentOrderId(input.orderId); const reference = normalizedReceiptReference(input.receiptReference); const amount = decimalMoney(input.amount);
    if (input.receivedConfirmed !== true || input.currency !== 'USD' || !Number.isSafeInteger(input.quoteRevision) || input.quoteRevision < 1) throw new Error('Independently verify incoming USD funds and current quote revision');
    return repository.withOrderLock(id, async () => {
      await repository.assertOrderOperable?.(id);
      const existing = await repository.getReceipt(reference);
      if (existing) {
        if (existing.platform !== 'shopify' || existing.orderKey !== orderKey(id) || existing.currency !== 'USD' || decimalMoney(existing.amount) !== amount || existing.quoteRevision !== input.quoteRevision) throw new Error('This actual receipt is already claimed by another amount or order');
        // Continue readback when a crash followed global receipt persistence.
      }
      const quote = await repository.getQuote(id);
      if (!quote || quote.revision !== input.quoteRevision) throw new Error('Quote revision changed');
      if (quote.status === 'paid' && existing) {
        const native = await readLivePaymentOrder(client, shop, id); const money = readOrderMoney(native);
        if (native.cancelledAt || native.displayFinancialStatus !== 'PAID' || money.outstanding !== '0.00' || ['total', 'subtotal', 'shipping', 'tax', 'discounts'].some(field => money[field] !== quote.nativeMoney[field])) throw new Error('Recorded native paid order changed; manual reconciliation is required');
        return { alreadyRecorded: true, quote, nativeMarkedPaid: true };
      }
      const order = await readLivePaymentOrder(client, shop, id); assertQuoteMatchesCurrent(quote, order, { shop, allowedManualGateways });
      const receipt = { reference, platform: 'shopify', orderKey: orderKey(id), currency: 'USD', amount, quoteRevision: quote.revision, createdAt: new Date(now()).toISOString() };
      const claim = await repository.claimReceipt(receipt);
      if (!claim || typeof claim.created !== 'boolean') throw new Error('Global receipt claim was not atomically acknowledged');
      const persisted = await repository.getReceipt(reference);
      if (!persisted || persisted.platform !== receipt.platform || persisted.orderKey !== receipt.orderKey || persisted.currency !== receipt.currency || persisted.quoteRevision !== receipt.quoteRevision || decimalMoney(persisted.amount) !== amount) throw new Error('Global receipt readback differs; do not reassign or duplicate incoming funds');
      const total = await receiptsTotal(id, quote.revision); const amountDue = moneyCents(quote.amount); const remaining = total >= amountDue ? 0n : amountDue - total;
      const updated = { ...quote, receivedAmount: centsMoney(total), remainingAmount: centsMoney(remaining), status: remaining > 0n ? 'partial' : 'received', paymentVersion: quote.paymentVersion + (quote.receivedAmount === centsMoney(total) ? 0 : 1), ...privateReceivingDetails(quote.receivingConfig, { amount: centsMoney(remaining), reference: quote.reference }) };
      await repository.saveQuote(id, updated);
      return { quote: updated, alreadyRecorded: !claim.created, nativeMarkedPaid: false, requiresExplicitMarkPaid: remaining === 0n };
    });
  }
  async function markPaid(input) {
    enabled(); const id = paymentOrderId(input.orderId); const key = operationKey(input.operationKey);
    if (input.receivedConfirmed !== true || input.markPaidConfirmed !== true || !Number.isSafeInteger(input.quoteRevision)) throw new Error('Explicitly confirm verified actual funds and native paid registration');
    const intent = { quoteRevision: input.quoteRevision };
    return repository.withOrderLock(id, async () => {
      await repository.assertOrderOperable?.(id);
      const prior = await checkOperation(key, 'paid', id, intent);
      if (prior) return { alreadyComplete: true, quote: await repository.getQuote(id) };
      const quote = await repository.getQuote(id);
      if (!quote || quote.revision !== input.quoteRevision || !['received', 'paid'].includes(quote.status)) throw new Error('Full actual receipts are required');
      if (quote.pendingPaymentOperationKey) throw new Error('A previous paid registration is unresolved; reconcile its original journal');
      const total = await receiptsTotal(id, quote.revision);
      if (total < moneyCents(quote.amount) || quote.receivedAmount !== centsMoney(total)) throw new Error('Actual receipt ledger is insufficient or inconsistent');
      const order = await readLivePaymentOrder(client, shop, id); const money = assertManualOrder(order, allowedManualGateways);
      if (order.displayFinancialStatus === 'PAID' && money.outstanding === '0.00') {
        if (['total', 'subtotal', 'shipping', 'tax', 'discounts'].some(field => money[field] !== quote.nativeMoney[field])) throw new Error('Paid native order changed; reconcile before fulfillment');
        const updated = { ...quote, status: 'paid', paymentVersion: quote.paymentVersion + 1, paidAt: new Date(now()).toISOString(), wisePaymentUrl: null };
        await repository.saveQuote(id, updated);
        await saveOperation({ key, kind: 'paid', shop, orderId: id, inputHash: digest(intent), input: intent, status: 'complete', stage: 'native-readback', startedAt: new Date(now()).toISOString() });
        return { alreadyPaidInNative: true, quote: updated, nativeVerified: true };
      }
      assertQuoteMatchesCurrent(quote, order, { shop, allowedManualGateways });
      const op = { key, kind: 'paid', shop, orderId: id, inputHash: digest(intent), input: intent, status: 'prepared', startedAt: new Date(now()).toISOString() }; await saveOperation(op);
      await repository.saveQuote(id, { ...quote, pendingPaymentOperationKey: key });
      await mutate(op, 'mark-paid', 'paid', { input: { id } }, 'orderMarkAsPaid');
      const after = await readLivePaymentOrder(client, shop, id);
      if (after.displayFinancialStatus !== 'PAID' || bag(after.totalOutstandingSet) !== '0.00' || bag(after.currentTotalPriceSet) !== quote.nativeMoney.total) { op.status = 'readback-mismatch'; await saveOperation(op); throw new Error('Native paid registration is not verified; investigate before retrying'); }
      const updated = { ...quote, status: 'paid', paymentVersion: quote.paymentVersion + 1, paidAt: new Date(now()).toISOString(), wisePaymentUrl: null, pendingPaymentOperationKey: null };
      await repository.saveQuote(id, updated); op.status = 'complete'; op.stage = 'verified'; await saveOperation(op);
      return { quote: updated, nativeVerified: true };
    });
  }
  async function reconcilePaid(operation) {
    enabled(); const key = operationKey(operation); const saved = await repository.getOperation(key);
    if (!saved || saved.kind !== 'paid' || saved.shop !== shop || !['unknown', 'in-flight', 'staged', 'readback-mismatch'].includes(saved.status)) throw new Error('An unresolved paid operation is required');
    return repository.withOrderLock(saved.orderId, async () => {
      await repository.assertOrderOperable?.(saved.orderId);
      const quote = await repository.getQuote(saved.orderId);
      if (!quote || (quote.pendingPaymentOperationKey !== key && !(quote.status === 'paid' && !quote.pendingPaymentOperationKey)) || quote.revision !== saved.input.quoteRevision || (await receiptsTotal(saved.orderId, quote.revision)) < moneyCents(quote.amount)) throw new Error('Original quote or receipt ledger changed');
      const order = await readLivePaymentOrder(client, shop, saved.orderId); const money = assertManualOrder(order, allowedManualGateways);
      if (order.displayFinancialStatus !== 'PAID' || money.outstanding !== '0.00') return { unresolved: true, replayed: false };
      if (['total', 'subtotal', 'shipping', 'tax', 'discounts'].some(field => money[field] !== quote.nativeMoney[field])) throw new Error('Native paid money does not match the original operation');
      const updated = { ...quote, status: 'paid', paymentVersion: quote.paymentVersion + (quote.status === 'paid' ? 0 : 1), paidAt: quote.paidAt || new Date(now()).toISOString(), wisePaymentUrl: null, pendingPaymentOperationKey: null };
      await repository.saveQuote(saved.orderId, updated); saved.status = 'complete'; saved.stage = 'reconciled-readback'; await saveOperation(saved);
      return { quote: updated, nativeVerified: true, replayed: false };
    });
  }
  return Object.freeze({ confirmShippingQuote, recordReceipt, markPaid, reconcilePaid });
}
