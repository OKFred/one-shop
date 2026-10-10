import { createPaymentRepository } from './paymentRepository.js';
import { createPaymentService, readLivePaymentOrder, paymentOrderId, moneyCents, centsMoney } from './payments.js';
import { createFulfillmentService, FULFILLMENT_GRAPHQL } from './fulfillment.js';
import { createCustomerPaymentAccess } from './customerAccess.js';

function stringList(value, name) {
  if (!value) return [];
  let list; try { list = JSON.parse(value); } catch { throw new Error(`${name} requires a reviewed JSON list`); }
  if (!Array.isArray(list) || list.length > 20 || list.some(item => typeof item !== 'string' || !item.trim() || item.length > 120 || /[\p{Cc}\p{Cf}]/u.test(item))) throw new Error(`${name} requires a reviewed JSON list`);
  return [...new Set(list.map(item => item.trim()))];
}
export function publicQuoteSummary(quote) {
  if (!quote) return null;
  const result = {};
  for (const key of ['status', 'revision', 'paymentVersion', 'currency', 'amount', 'receivedAmount', 'remainingAmount', 'shippingTitle', 'shippingAmount', 'reference', 'pendingOperationKey', 'pendingPaymentOperationKey', 'pendingFulfillmentOperationKey']) {
    if (quote[key] !== undefined) result[key] = quote[key];
  }
  return result;
}
export function createReceivingProvider(loader) {
  if (typeof loader !== 'function') throw new Error('Verified native receiving configuration loader is required');
  return async () => {
    const native = await loader();
    if (!Array.isArray(native?.accounts?.USD?.fields) || !native.accounts.USD.fields.length) throw new Error('Verified USD business receiving details are required');
    // Native loader validates the private file, explicit USD approval, actual
    // receiving fields and official Wise Business URL. Never guess a conversion
    // from GBP/EUR or use the public payment-setting placeholder fields.
    return { verified: true, bankDetails: native.accounts.USD.fields, wiseBusinessOpenLink: native.openLink || null };
  };
}
export function createPaymentRuntime({ runtime, env = process.env, receivingLoader, now = Date.now } = {}) {
  if (!runtime?.config?.enabled || !runtime.pool || !runtime.client || typeof runtime.repositories?.mappings?.getOperation !== 'function') throw new Error('Shopify bridge runtime is unavailable');
  const { config, pool, client } = runtime;
  const repository = createPaymentRepository({ pool, shop: config.shop });
  const allowedManualGateways = stringList(env.SHOPIFY_MANUAL_GATEWAYS, 'SHOPIFY_MANUAL_GATEWAYS');
  const allowedLocationIds = stringList(env.SHOPIFY_FULFILLMENT_LOCATION_IDS, 'SHOPIFY_FULFILLMENT_LOCATION_IDS');
  const paymentFeatureEnabled = env.SHOPIFY_PAYMENT_OPERATIONS_ENABLED === 'true';
  const writesEnabled = config.writesEnabled === true && paymentFeatureEnabled;
  if (paymentFeatureEnabled && !allowedManualGateways.length) throw new Error('Verified Shopify manual payment gateway names are required');
  const payments = createPaymentService({ shop: config.shop, client, repository, receivingConfig: createReceivingProvider(receivingLoader), allowedManualGateways, writesEnabled, now });
  const fulfillment = createFulfillmentService({ shop: config.shop, client, repository, allowedLocationIds, writesEnabled, now });
  const customerAccess = paymentFeatureEnabled ? createCustomerPaymentAccess({ shop: config.shop, client, repository,
    appSecret: config.clientSecret, clientId: config.clientId, accessSecret: env.SHOPIFY_PAYMENT_ACCESS_SECRET,
    appUrl: config.appUrl, allowedManualGateways, now }) : null;
  async function inspect(orderId) {
    paymentOrderId(orderId);
    const [nativeOrder, shipping, quote, receipts, intent] = await Promise.all([
      readLivePaymentOrder(client, config.shop, orderId),
      client.request(FULFILLMENT_GRAPHQL.order, { id: orderId }),
      repository.getQuote(orderId), repository.listReceipts(`${config.shop}:${orderId}`),
      runtime.repositories.mappings.getOperation(`order-restock:${orderId}`)
    ]);
    if (shipping?.shop?.myshopifyDomain !== config.shop || shipping.order?.id !== orderId) throw new Error('Shipment order is unavailable in the verified shop');
    let cancellation = null;
    if (intent) {
      if (intent.kind !== 'order-cancel' || intent.shop !== config.shop || intent.orderId !== orderId ||
          !['prepared', 'in-flight', 'pending', 'unknown', 'review', 'complete'].includes(intent.status) ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(intent.operationKey || '') || !['CUSTOMER', 'INVENTORY', 'OTHER'].includes(intent.input?.reason)) {
        throw new Error('Original cancellation intent requires identity review');
      }
      cancellation = { status: intent.status, operationKey: intent.operationKey, reason: intent.input.reason };
    }
    return { quote: publicQuoteSummary(quote), cancellation, receipts: { count: receipts.length, receivedAmount: centsMoney(receipts.reduce((sum, receipt) => sum + moneyCents(receipt.amount), 0n)) },
      nativeOrder: { id: nativeOrder.id, displayFinancialStatus: nativeOrder.displayFinancialStatus,
        cancelledAt: nativeOrder.cancelledAt, closed: nativeOrder.closed,
        fulfillmentOrders: shipping.order.fulfillmentOrders, fulfillments: shipping.order.fulfillments } };
  }
  return { config, repository, payments, fulfillment, customerAccess, inspect, writesEnabled };
}

// Lazy imports keep pure route tests independent of native configuration and
// never read a receiving file until a merchant confirms a shipping quote.
export async function paymentRuntime() {
  const [{ bridgeRuntime }, { loadReceivingConfig }] = await Promise.all([
    import('./runtime.js'), import('../../../bank-transfer/src/services/receivingConfig.js')
  ]);
  return createPaymentRuntime({ runtime: bridgeRuntime(), receivingLoader: loadReceivingConfig });
}
