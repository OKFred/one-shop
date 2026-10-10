import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { grantedScopesSatisfy, normalizeShop } from './config.js';

export class ShopifyAuthorizationError extends Error { constructor(message) { super(message); this.name = 'ShopifyAuthorizationError'; this.code = 'SHOPIFY_REAUTHORIZE'; } }
export class ShopifyTokenRetryError extends Error { constructor() { super('Shopify token refresh needs retry; the previous encrypted token is retained'); this.name = 'ShopifyTokenRetryError'; this.code = 'SHOPIFY_TOKEN_RETRY'; } }

const localQueues = new Map();
async function serialized(shop, work) {
  // Session advisory locks are reentrant on one connection. A nested caller can
  // issue concurrent API reads, so also serialize token rotations in-process.
  const previous = localQueues.get(shop) || Promise.resolve();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => held);
  localQueues.set(shop, queued);
  await previous;
  try { return await work(); }
  finally { release(); if (localQueues.get(shop) === queued) localQueues.delete(shop); }
}

export function encryptTokens(tokens, key, shop) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid token encryption key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`shusha-shopify-token-v1:${normalizeShop(shop)}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptTokens(envelope, key, shop) {
  try {
    const [version, iv, tag, ciphertext, extra] = String(envelope).split('.');
    if (version !== 'v1' || extra || !iv || !tag || !ciphertext || Buffer.from(iv, 'base64url').length !== 12 || Buffer.from(tag, 'base64url').length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`shusha-shopify-token-v1:${normalizeShop(shop)}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
  } catch (_) { throw new Error('Stored Shopify credential cannot be authenticated'); }
}

function tokenRecord(value, config, now) {
  if (typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token ||
      !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0 || !Number.isSafeInteger(value.refresh_token_expires_in) || value.refresh_token_expires_in <= 0) {
    throw new Error('Shopify did not return valid expiring offline credentials');
  }
  if (!grantedScopesSatisfy(config.scopes, value.scope)) throw new ShopifyAuthorizationError('Shopify authorization is missing requested scopes');
  return { accessToken: value.access_token, refreshToken: value.refresh_token, scopes: value.scope,
    expiresAt: now() + value.expires_in * 1000, refreshExpiresAt: now() + value.refresh_token_expires_in * 1000 };
}

export function createTokenStore({ repository, config, fetchImpl = fetch, now = Date.now }) {
  const shop = normalizeShop(config.shop);
  for (const method of ['withLock', 'get', 'save', 'remove']) if (typeof repository[method] !== 'function') throw new Error(`Token repository requires ${method}`);
  async function exchange(params) {
    let response;
    try {
      response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }), signal: AbortSignal.timeout(30000) });
    } catch (_) { throw new ShopifyTokenRetryError(); }
    if (response.status === 401 || response.status === 403) throw new ShopifyAuthorizationError('Shopify authorization must be reviewed');
    if (response.status === 429 || response.status >= 500) throw new ShopifyTokenRetryError();
    if (!response.ok) throw new Error(`Shopify token request rejected (${response.status})`);
    let result;
    try { result = await response.json(); } catch (_) { throw new ShopifyTokenRetryError(); }
    return result;
  }
  const persist = async (tokens) => repository.save(shop, { envelope: encryptTokens(tokens, config.encryptionKey, shop), updatedAt: new Date(now()).toISOString() });
  return {
    async exchangeCode(code) {
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{8,512}$/.test(code)) throw new Error('Invalid OAuth authorization code');
      return serialized(shop, () => repository.withLock(shop, async () => {
        const tokens = tokenRecord(await exchange({ code, expiring: '1' }), config, now);
        await persist(tokens);
        return { shop, scopes: tokens.scopes, expiresAt: tokens.expiresAt };
      }));
    },
    async getAccessToken() {
      return serialized(shop, () => repository.withLock(shop, async () => {
        const saved = await repository.get(shop);
        if (!saved) throw new ShopifyAuthorizationError('Shopify installation is required');
        const tokens = decryptTokens(saved.envelope, config.encryptionKey, shop);
        if (tokens.expiresAt > now() + 60000) return tokens.accessToken;
        if (tokens.refreshExpiresAt <= now()) throw new ShopifyAuthorizationError('Shopify refresh token has expired');
        let response;
        try { response = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }); }
        catch (error) {
          // Keep rejected credentials for private diagnosis. No 401 refresh loop.
          throw error;
        }
        const refreshed = tokenRecord({ ...response, scope: response.scope ?? tokens.scopes }, config, now);
        await persist(refreshed);
        return refreshed.accessToken;
      }));
    },
    async revoke() { return serialized(shop, () => repository.withLock(shop, () => repository.remove(shop))); }
  };
}
