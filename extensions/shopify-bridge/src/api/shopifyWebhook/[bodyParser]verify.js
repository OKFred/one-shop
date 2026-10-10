import { verifyWebhookHmac, validateWebhookEnvelope } from '../../services/security.js';
import { bridgeRuntime } from '../../services/runtime.js';
const TOPICS = ['orders/create','orders/updated','orders/cancelled','refunds/create','fulfillments/create','fulfillments/update','app/uninstalled'];
export default async (request,response) => {
  try {
    const {config,pool} = bridgeRuntime();
    if (!Buffer.isBuffer(request.body) || !verifyWebhookHmac(request.body,request.get('X-Shopify-Hmac-Sha256'),config.clientSecret)) return response.status(401).end();
    const shop = request.get('X-Shopify-Shop-Domain');
    const topic = request.get('X-Shopify-Topic');
    const deliveryId = request.get('X-Shopify-Webhook-Id');
    validateWebhookEnvelope({shop,expectedShop:config.shop,topic,allowedTopics:TOPICS,deliveryId});
    const payload = JSON.parse(request.body.toString('utf8'));
    await pool.query('INSERT INTO shusha_bridge_inbox(delivery_id,shop,topic,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[deliveryId,shop,topic,JSON.stringify(payload)]);
    response.status(200).end();
  } catch { response.status(503).end(); }
};
