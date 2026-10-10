import { consumeOAuthState, verifyOAuthHmac } from '../../services/security.js';
import { bridgeRuntime } from '../../services/runtime.js';
export default async (request,response) => {
  response.set('Cache-Control','no-store');
  try {
    const user = request.getCurrentUser();
    if (!user?.uuid) return response.status(401).json({error:'ADMIN_REQUIRED'});
    const {config,repositories,tokens} = bridgeRuntime();
    if (!verifyOAuthHmac(request.query,config.clientSecret) || request.query.shop !== config.shop) throw new Error('INVALID_CALLBACK');
    await consumeOAuthState(request.query.state,{shop:config.shop,sessionId:user.uuid,secret:config.clientSecret,consumeNonce:repositories.consumeNonce});
    await tokens.exchangeCode(request.query.code);
    response.redirect('/admin/shopify-bridge?authorized=1');
  } catch { response.status(400).json({error:'SHOPIFY_AUTHORIZATION_FAILED'}); }
};
