import { pool } from '@evershop/evershop/lib/postgres';
import { listUnifiedOrders,getUnifiedOrder } from '../../services/orders.js';
import { normalizeShop } from '../../services/config.js';
export default async (request,response,next) => {
  response.set('Cache-Control','no-store');
  try {
    const platform=request.query.platform || 'all';
    if (request.query.orderId) {
      const order=await getUnifiedOrder(pool,platform,request.query.orderId);
      if (!order) return response.status(404).json({error:'ORDER_UNAVAILABLE'});
      return response.json({data:order});
    }
    const offset=Number(request.query.offset || 0);
    const orders=await listUnifiedOrders(pool,{platform,offset,limit:30});
    let shopDomain=null;
    if(process.env.SHOPIFY_SHOP)shopDomain=normalizeShop(process.env.SHOPIFY_SHOP);
    response.json({data:{orders,shopDomain}});
  } catch { response.status(400).json({error:'ORDER_VIEW_UNAVAILABLE'}); }
};
