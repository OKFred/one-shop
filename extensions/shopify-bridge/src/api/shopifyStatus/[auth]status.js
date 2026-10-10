import { pool } from '@evershop/evershop/lib/postgres';
export default async (request,response,next) => {
  response.set('Cache-Control','no-store');
  try {
    const connected = (await pool.query('SELECT count(*)::int AS n FROM shusha_bridge_token')).rows[0].n > 0;
    const products = (await pool.query("SELECT count(*)::int AS n FROM shusha_bridge_mapping WHERE kind='product'")).rows[0].n;
    response.json({data:{enabled:process.env.SHOPIFY_BRIDGE_ENABLED==='true',writesEnabled:process.env.SHOPIFY_BRIDGE_WRITES_ENABLED==='true',connected,mappedStyles:products}});
  } catch { response.status(503).json({error:'SHOPIFY_BRIDGE_NOT_MIGRATED'}); }
};
