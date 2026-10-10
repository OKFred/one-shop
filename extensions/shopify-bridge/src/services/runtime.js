import { pool } from '@evershop/evershop/lib/postgres';
import { loadConfig } from './config.js';
import { createRepositories } from './repositories.js';
import { createTokenStore } from './tokenStore.js';
import { createShopifyClient } from './shopifyClient.js';

export function bridgeRuntime() {
  const config = loadConfig();
  if (!config.enabled) throw new Error('SHOPIFY_BRIDGE_DISABLED');
  const repositories = createRepositories(pool);
  const tokens = createTokenStore({repository:repositories.tokens,config});
  const client = createShopifyClient({shop:config.shop,getAccessToken:() => tokens.getAccessToken()});
  return {config,repositories,tokens,client,pool};
}
