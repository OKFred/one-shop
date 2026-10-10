import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { API_VERSION, loadConfig, normalizeShop, grantedScopesSatisfy } from '../src/services/config.js';
import { createOAuthState, consumeOAuthState, verifyOAuthHmac, verifyWebhookHmac, createAuthorizationUrl, validateWebhookEnvelope } from '../src/services/security.js';
import { encryptTokens, decryptTokens, createTokenStore } from '../src/services/tokenStore.js';

const shop = 'synthetic-shop.myshopify.com';
const key = Buffer.alloc(32, 7);
const env = { SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_SHOP: shop, SHOPIFY_APP_URL: 'https://example.test', SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: 'synthetic-secret', SHOPIFY_TOKEN_ENCRYPTION_KEY: key.toString('base64') };
const config = loadConfig(env);

test('disabled integration needs no credentials; enabled config pins API and HTTPS target', () => {
  assert.deepEqual(loadConfig({}), { enabled: false, apiVersion: API_VERSION });
  assert.equal(config.apiVersion, '2026-10'); assert.equal(config.writesEnabled, false);
  for (const bad of ['synthetic-shop.myshopify.com.evil.test', 'https://synthetic-shop.myshopify.com', 'SYNTHETIC.myshopify.com', 'localhost', 'a@synthetic-shop.myshopify.com']) assert.throws(() => normalizeShop(bad));
  assert.throws(() => loadConfig({ ...env, SHOPIFY_API_VERSION: '2026-07' }), /reviewed upgrade/);
  assert.throws(() => loadConfig({ ...env, SHOPIFY_APP_URL: 'http://example.test' }));
  assert.throws(() => loadConfig({ ...env, SHOPIFY_TOKEN_ENCRYPTION_KEY: 'not-a-key' }));
  assert.equal(grantedScopesSatisfy(['read_products', 'write_files'], 'write_products,write_files'), true);
  assert.equal(grantedScopesSatisfy(['write_products'], 'read_products'), false);
});

test('OAuth verifies sorted decoded callback fields and rejects duplicates, arrays and altered callbacks', () => {
  const params = new URLSearchParams({ code: 'synthetic-code', shop, state: 'synthetic-state', timestamp: '1000' });
  const message = [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('&');
  params.set('hmac', createHmac('sha256', config.clientSecret).update(message).digest('hex'));
  assert.equal(verifyOAuthHmac(params, config.clientSecret), true);
  assert.equal(verifyOAuthHmac({ ...Object.fromEntries(params), code: 'altered' }, config.clientSecret), false);
  params.append('shop', shop); assert.equal(verifyOAuthHmac(params, config.clientSecret), false);
  assert.equal(verifyOAuthHmac({ hmac: '0'.repeat(64), code: ['x'] }, config.clientSecret), false);
});

test('webhook HMAC covers original bytes and store/topic/delivery allowlist', () => {
  const body = Buffer.from('{"id":1,"value":"synthetic"}');
  const signature = createHmac('sha256', config.clientSecret).update(body).digest('base64');
  assert.equal(verifyWebhookHmac(body, signature, config.clientSecret), true);
  assert.equal(verifyWebhookHmac(Buffer.from('{ "id":1,"value":"synthetic"}'), signature, config.clientSecret), false);
  assert.equal(verifyWebhookHmac(body.toString(), signature, config.clientSecret), false);
  assert.equal(verifyWebhookHmac(body, signature.slice(1), config.clientSecret), false);
  const envelope = { shop, expectedShop: shop, topic: 'orders/create', allowedTopics: ['orders/create'], deliveryId: 'synthetic-delivery-001' };
  assert.equal(validateWebhookEnvelope(envelope).topic, 'orders/create');
  assert.throws(() => validateWebhookEnvelope({ ...envelope, shop: 'other.myshopify.com' }));
  assert.throws(() => validateWebhookEnvelope({ ...envelope, topic: 'orders/unsupported' }));
});

test('OAuth state binds authenticated merchant, shop, expiry and atomic nonce replay protection', async () => {
  let time = 1000000; const consumed = new Set();
  const options = { shop, sessionId: 'synthetic-admin-session-001', secret: config.clientSecret, now: () => time,
    consumeNonce: async (nonce) => { if (consumed.has(nonce)) return false; consumed.add(nonce); return true; } };
  const token = createOAuthState(options);
  const authUrl = new URL(createAuthorizationUrl(config, { state: token }));
  assert.equal(authUrl.hostname, shop); assert.equal(authUrl.searchParams.get('redirect_uri'), config.redirectUri);
  await assert.rejects(consumeOAuthState(token, { ...options, sessionId: 'other-merchant-session' }), /mismatched/);
  await assert.rejects(consumeOAuthState(token, { ...options, shop: 'other.myshopify.com' }), /mismatched/);
  await consumeOAuthState(token, options);
  await assert.rejects(consumeOAuthState(token, options), /already been consumed/);
  time += 600001; await assert.rejects(consumeOAuthState(token, options), /Expired/);
});

test('AES-GCM encrypts both tokens, binds store and refuses corrupted/wrong-key envelopes', () => {
  const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 1000 };
  const envelope = encryptTokens(tokens, key, shop);
  assert.equal(envelope.includes(tokens.accessToken), false); assert.equal(envelope.includes(tokens.refreshToken), false);
  assert.deepEqual(decryptTokens(envelope, key, shop), tokens);
  assert.notEqual(envelope, encryptTokens(tokens, key, shop));
  assert.throws(() => decryptTokens(envelope, key, 'other.myshopify.com'), /authenticated/);
  assert.throws(() => decryptTokens(envelope, Buffer.alloc(32, 8), shop), /authenticated/);
  const parts = envelope.split('.'); parts[2] = Buffer.alloc(16).toString('base64url');
  assert.throws(() => decryptTokens(parts.join('.'), key, shop), /authenticated/);
});

function repository() {
  let saved; let queue = Promise.resolve();
  return { async withLock(_, fn) { const prior = queue; let resolve; queue = new Promise((r) => { resolve = r; }); await prior; try { return await fn(); } finally { resolve(); } },
    async get() { return saved; }, async save(_, record) { saved = record; }, async remove() { saved = null; } };
}
function response(access = 'synthetic-access', refresh = 'synthetic-refresh') {
  return { access_token: access, refresh_token: refresh, scope: 'write_products,write_files', expires_in: 3600, refresh_token_expires_in: 7776000 };
}

test('offline exchange uses expiring grant; concurrent expiry refresh rotates and persists one new token pair', async () => {
  let time = 1000000; let calls = 0; const repo = repository(); const bodies = [];
  const store = createTokenStore({ repository: repo, config, now: () => time, fetchImpl: async (_, options) => {
    bodies.push(options.body); calls++; return new Response(JSON.stringify(calls === 1 ? response() : response('synthetic-new-access', 'synthetic-new-refresh')));
  } });
  const metadata = await store.exchangeCode('synthetic-code-001');
  assert.equal(bodies[0].get('expiring'), '1'); assert.equal('accessToken' in metadata, false);
  assert.equal(await store.getAccessToken(), 'synthetic-access'); assert.equal(calls, 1);
  time += 3600000;
  assert.deepEqual(await Promise.all([store.getAccessToken(), store.getAccessToken(), store.getAccessToken()]), Array(3).fill('synthetic-new-access'));
  assert.equal(calls, 2); assert.equal(bodies[1].get('grant_type'), 'refresh_token');
  const record = decryptTokens((await repo.get()).envelope, key, shop);
  assert.equal(record.refreshToken, 'synthetic-new-refresh');
});

test('transient token failure retains original encrypted pair and missing scopes never persists', async () => {
  const repo = repository(); let time = 1; let fail = false;
  const store = createTokenStore({ repository: repo, config, now: () => time, fetchImpl: async () => fail ? new Response('', { status: 500 }) : new Response(JSON.stringify(response())) });
  await store.exchangeCode('synthetic-code-002'); const prior = (await repo.get()).envelope; time += 3600000; fail = true;
  await assert.rejects(store.getAccessToken(), { code: 'SHOPIFY_TOKEN_RETRY' });
  assert.equal((await repo.get()).envelope, prior);
  const other = repository(); const missing = createTokenStore({ repository: other, config, fetchImpl: async () => new Response(JSON.stringify({ ...response(), scope: 'read_products' })) });
  await assert.rejects(missing.exchangeCode('synthetic-code-003'), { code: 'SHOPIFY_REAUTHORIZE' }); assert.equal(await other.get(), undefined);
});
