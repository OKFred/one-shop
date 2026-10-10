import { consumeOAuthState, verifyOAuthHmac } from '../../services/security.js';
import { bridgeRuntime } from '../../services/runtime.js';
export default async (request,response,next) => {
  response.set('Cache-Control','no-store');
  try {
    const user = request.getCurrentUser();
    if (!user?.uuid) return response.status(401).json({error:'ADMIN_REQUIRED'});
    const {config,repositories,tokens,client} = bridgeRuntime();
    if (!verifyOAuthHmac(request.query,config.clientSecret) || request.query.shop !== config.shop) throw new Error('INVALID_CALLBACK');
    await consumeOAuthState(request.query.state,{shop:config.shop,sessionId:user.uuid,secret:config.clientSecret,consumeNonce:repositories.consumeNonce});
    await tokens.exchangeCode(request.query.code);
    const {shop} = await client.request('query ShushaInstalledShop { shop { id myshopifyDomain } }',{});
    if (shop?.myshopifyDomain !== config.shop || !/^gid:\/\/shopify\/Shop\/\d+$/.test(shop.id || '')) throw new Error('SHOP_IDENTITY_UNVERIFIED');
    await repositories.mappings.saveOperation(`installation:${config.shop}`,{kind:'installation',status:'complete',shop:config.shop,shopId:shop.id.split('/').pop()});
    response.redirect('/admin/shopify-bridge?authorized=1');
  } catch { response.status(400).json({error:'SHOPIFY_AUTHORIZATION_FAILED'}); }
};
