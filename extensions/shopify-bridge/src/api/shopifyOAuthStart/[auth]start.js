import { createOAuthState, createAuthorizationUrl } from '../../services/security.js';
import { bridgeRuntime } from '../../services/runtime.js';
export default async (request,response,next) => {
  try {
    const user = request.getCurrentUser();
    if (!user?.uuid) return response.status(401).json({error:'ADMIN_REQUIRED'});
    const {config} = bridgeRuntime();
    const state = createOAuthState({shop:config.shop,sessionId:user.uuid,secret:config.clientSecret});
    response.set('Cache-Control','no-store');
    response.redirect(createAuthorizationUrl(config,{state}));
  } catch { response.status(503).json({error:'SHOPIFY_AUTH_CONFIGURATION_UNAVAILABLE'}); }
};
