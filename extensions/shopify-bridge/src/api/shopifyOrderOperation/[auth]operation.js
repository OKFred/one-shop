import { createCancellationService } from '../../services/cancellation.js';
import { ingestShopifyOrder } from '../../services/orders.js';
import { withTransaction } from '../../services/outbox.js';
import { freezeSku } from '../../services/inventory.js';

async function nativeService(env) {
  const [{ bridgeRuntime }, { createPaymentRepository }] = await Promise.all([
    import('../../services/runtime.js'), import('../../services/paymentRepository.js')
  ]);
  const runtime = bridgeRuntime(); const { config, pool, client, repositories } = runtime;
  const locations = JSON.parse(env.SHOPIFY_FULFILLMENT_LOCATION_IDS || '[]');
  if (!Array.isArray(locations) || locations.length > 20) throw new Error('Reviewed native restock locations are required');
  return createCancellationService({ shop: config.shop, client, mappingStore: repositories.mappings,
    quoteRepository: createPaymentRepository({ pool, shop: config.shop }), approvedLocationIds: locations,
    writesEnabled: config.writesEnabled === true,
    observeOrder: (order, options) => ingestShopifyOrder(pool, order, options),
    assertMappedLines: async (lines) => {
      const skus = [...new Set(lines.map((line) => line.sku))];
      const rows = (await pool.query('SELECT sku FROM shusha_bridge_inventory WHERE sku=ANY($1::text[])', [skus])).rows;
      if (rows.length !== skus.length) throw new Error('Every restock line needs its opened central capacity');
    },
    freezeCapacity: (lines) => withTransaction(pool, async (connection) => {
      for (const sku of [...new Set(lines.map((line) => line.sku))].sort()) await freezeSku(connection, sku, 'native-cancellation-outcome-requires-review');
    })
  });
}

export function createOrderOperationHandler({ env = process.env, getService = nativeService } = {}) {
  return async (request, response, _next) => {
    response.set('Cache-Control', 'no-store');
    if (!request.getCurrentUser?.()?.uuid) return response.status(401).json({ error: 'ADMIN_REQUIRED' });
    if (['SHOPIFY_BRIDGE_ENABLED','SHOPIFY_BRIDGE_WRITES_ENABLED','SHOPIFY_SHARED_CAPACITY_ENABLED','SHOPIFY_PAYMENT_OPERATIONS_ENABLED','SHOPIFY_ORDER_OPERATIONS_ENABLED'].some((key) => env[key] !== 'true')) {
      return response.status(503).json({ error: 'NATIVE_ORDER_OPERATIONS_DISABLED' });
    }
    try {
      const origin = new URL(env.SHOPIFY_APP_URL);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
          request.get?.('Origin') !== origin.origin) return response.status(403).json({ error: 'SAME_ORIGIN_REQUIRED' });
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((key) => !['action','orderId','operationKey','reason','merchantConfirmed'].includes(key)) ||
          !['cancel','reconcile-cancel'].includes(body.action)) return response.status(400).json({ error: 'ORDER_ACTION_UNAVAILABLE' });
      const service = await getService(env);
      const input = { orderId: body.orderId, operationKey: body.operationKey, reason: body.reason, merchantConfirmed: body.merchantConfirmed };
      const result = body.action === 'cancel' ? await service.cancel(input) : await service.reconcile(input);
      return response.status(result.requiresMerchantReview ? 409 : result.status === 'complete' ? 200 : 202).json({ data: result });
    } catch { return response.status(409).json({ error: 'NATIVE_CANCELLATION_REQUIRES_REVIEW' }); }
  };
}
export default createOrderOperationHandler();
