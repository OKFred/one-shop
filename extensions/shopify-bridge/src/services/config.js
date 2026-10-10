export const API_VERSION = '2026-10';
export const FOUNDATION_SCOPES = Object.freeze(['read_products', 'write_products', 'read_files', 'write_files']);

export function normalizeShop(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(value)) {
    throw new Error('Shopify shop must be a lowercase myshopify.com hostname');
  }
  return value;
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim() || /[\r\n\u0000]/.test(value)) throw new Error(`${name} is required in the server environment`);
  return value.trim();
}

export function loadConfig(env = process.env) {
  const enabled = env.SHOPIFY_BRIDGE_ENABLED === 'true';
  if (!enabled) return Object.freeze({ enabled: false, apiVersion: API_VERSION });
  if (env.SHOPIFY_API_VERSION && env.SHOPIFY_API_VERSION !== API_VERSION) throw new Error('Shopify API version requires a reviewed upgrade');
  const shop = normalizeShop(required(env, 'SHOPIFY_SHOP'));
  const appUrl = new URL(required(env, 'SHOPIFY_APP_URL'));
  if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password || appUrl.search || appUrl.hash || appUrl.pathname !== '/') {
    throw new Error('SHOPIFY_APP_URL must be an HTTPS origin');
  }
  const encryptionKey = Buffer.from(required(env, 'SHOPIFY_TOKEN_ENCRYPTION_KEY'), 'base64');
  if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== env.SHOPIFY_TOKEN_ENCRYPTION_KEY.trim()) {
    throw new Error('SHOPIFY_TOKEN_ENCRYPTION_KEY must be a canonical base64 32-byte key');
  }
  const scopes = [...new Set((env.SHOPIFY_SCOPES || FOUNDATION_SCOPES.join(',')).split(',').map((value) => value.trim()))];
  if (!scopes.length || scopes.some((scope) => !/^(read|write)_[a-z_]+$/.test(scope))) throw new Error('Invalid SHOPIFY_SCOPES');
  const config = {
    enabled, shop, apiVersion: API_VERSION, appUrl: appUrl.origin,
    clientId: required(env, 'SHOPIFY_CLIENT_ID'), clientSecret: required(env, 'SHOPIFY_CLIENT_SECRET'),
    encryptionKey, scopes: Object.freeze(scopes),
    redirectUri: `${appUrl.origin}/api/shopify/oauth/callback`,
    writesEnabled: env.SHOPIFY_BRIDGE_WRITES_ENABLED === 'true'
  };
  // Do not serialize this object into diagnostics or API responses.
  return Object.freeze(config);
}

export function grantedScopesSatisfy(requested, granted) {
  const actual = new Set(String(granted).split(',').map((value) => value.trim()));
  return requested.every((scope) => actual.has(scope) || (scope.startsWith('read_') && actual.has(`write_${scope.slice(5)}`)));
}
