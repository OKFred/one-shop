import { pool } from '@evershop/evershop/lib/postgres';
export default async (request,response,next) => {
  response.set('Cache-Control','no-store');
  try {
    const connected = (await pool.query('SELECT count(*)::int AS n FROM shusha_bridge_token')).rows[0].n > 0;
    const products = (await pool.query("SELECT count(*)::int AS n FROM shusha_bridge_mapping WHERE kind='product'")).rows[0].n;
    const enabled=process.env.SHOPIFY_BRIDGE_ENABLED==='true';
    const writesEnabled=enabled&&process.env.SHOPIFY_BRIDGE_WRITES_ENABLED==='true';
    const paymentWritesEnabled=writesEnabled&&process.env.SHOPIFY_PAYMENT_OPERATIONS_ENABLED==='true';
    const orderWritesEnabled=paymentWritesEnabled&&process.env.SHOPIFY_SHARED_CAPACITY_ENABLED==='true'&&process.env.SHOPIFY_ORDER_OPERATIONS_ENABLED==='true';
    response.json({data:{enabled,writesEnabled,paymentWritesEnabled,orderWritesEnabled,connected,mappedStyles:products}});
  } catch { response.status(503).json({error:'SHOPIFY_BRIDGE_NOT_MIGRATED'}); }
};
