import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { createHmac } from 'node:crypto';
import { registerHooks } from 'node:module';
import { createRepositories } from '../src/services/repositories.js';
import { createTokenStore, encryptTokens } from '../src/services/tokenStore.js';
import migration from '../src/migration/Version-1.0.0.js';
import rawParser from '../src/api/shopifyWebhook/[context]bodyParser[verify].js';
import { createOAuthState, verifyWebhookHmac } from '../src/services/security.js';
import { parseFromFile } from '../../../packages/evershop/dist/lib/middleware/parseFromFile.js';
import { sortMiddlewares } from '../../../packages/evershop/dist/lib/middleware/sort.js';
import { buildMiddlewareFunction } from '../../../packages/evershop/dist/lib/middleware/buildMiddlewareFunction.js';

function poolFixture() {
  const log = []; const records = new Map(); let envelope; let connects = 0; let releases = 0;
  const query = async (session, sql, params = []) => {
    log.push({ session, sql, params });
    if (sql.startsWith('INSERT INTO shusha_bridge_mapping')) { records.set(`${params[0]}:${params[1]}`, JSON.parse(params[2])); return { rowCount: 1, rows: [] }; }
    if (sql.startsWith('SELECT record')) return { rows: records.has(`${params[0]}:${params[1]}`) ? [{ record: records.get(`${params[0]}:${params[1]}`) }] : [] };
    if (sql.startsWith('INSERT INTO shusha_bridge_token')) { envelope = params[1]; return { rowCount: 1, rows: [{ revision: 1 }] }; }
    if (sql.startsWith('SELECT envelope')) return { rows: envelope ? [{ envelope, revision: 1 }] : [] };
    return { rowCount: 1, rows: [] };
  };
  return { log, records, get connects() { return connects; }, get releases() { return releases; }, async query(sql, params) { return query('pool', sql, params); },
    async connect() { const session = ++connects; return { async query(sql, params) { return query(session, sql, params); }, release() { releases++; } }; } };
}

test('catalog/media/token nested session locks use one connection and persist intent before external effect', async () => {
  const pool = poolFixture(); const repo = createRepositories(pool); let remoteObserved = false;
  await repo.mappings.withLock('product:synthetic', async () => {
    await repo.mappings.saveOperation('synthetic-op', { status: 'sent', input: { synthetic: true } });
    await repo.mappings.withLock('media:synthetic', async () => {
      await repo.tokens.withLock('synthetic-shop.myshopify.com', async () => {
        await repo.tokens.save('synthetic-shop.myshopify.com', { envelope: 'synthetic-encrypted-envelope' });
        assert.equal(pool.records.get('operation:synthetic-op').status, 'sent');
        remoteObserved = true;
      });
    });
  });
  assert.equal(remoteObserved, true); assert.equal(pool.connects, 1); assert.equal(pool.releases, 1);
  assert.equal(new Set(pool.log.map((entry) => entry.session)).size, 1);
  assert.equal(pool.log.some((entry) => /^BEGIN\b/.test(entry.sql)), false);
  const locks = pool.log.filter((entry) => /pg_advisory_lock/.test(entry.sql)); const unlocks = pool.log.filter((entry) => /pg_advisory_unlock/.test(entry.sql));
  assert.equal(locks.length, 3); assert.deepEqual(unlocks.map((entry) => entry.params[0]), locks.map((entry) => entry.params[0]).reverse());
});

test('remote exception retains durable operation and releases session locks for recovery', async () => {
  const pool = poolFixture(); const repo = createRepositories(pool);
  await assert.rejects(repo.mappings.withLock('product:synthetic', async () => {
    await repo.mappings.saveOperation('synthetic-unknown', { status: 'sent' });
    throw new Error('synthetic transport failure');
  }), /transport failure/);
  assert.equal(pool.records.get('operation:synthetic-unknown').status, 'sent'); assert.equal(pool.releases, 1);
  assert.equal(pool.log.at(-1).sql.includes('pg_advisory_unlock'), true);
});

test('concurrent reads inside the same reentrant PostgreSQL session rotate an expired token only once', async () => {
  const pool = poolFixture(); const repo = createRepositories(pool); const shop = 'synthetic-shop.myshopify.com'; const key = Buffer.alloc(32, 9);
  const config = { shop, clientId: 'synthetic-client', clientSecret: 'synthetic-secret', scopes: ['read_products'], encryptionKey: key };
  await repo.tokens.save(shop, { envelope: encryptTokens({ accessToken: 'synthetic-old', refreshToken: 'synthetic-refresh', scopes: 'read_products', expiresAt: 1, refreshExpiresAt: 999999999 }, key, shop) });
  let requests = 0;
  const tokens = createTokenStore({ repository: repo.tokens, config, now: () => 100000, fetchImpl: async () => {
    requests++; await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ access_token: 'synthetic-new', refresh_token: 'synthetic-new-refresh', scope: 'read_products', expires_in: 3600, refresh_token_expires_in: 100000 }));
  } });
  await repo.mappings.withLock('product:synthetic', async () => {
    assert.deepEqual(await Promise.all([tokens.getAccessToken(), tokens.getAccessToken(), tokens.getAccessToken()]), Array(3).fill('synthetic-new'));
  });
  assert.equal(requests, 1);
});

test('foundation migration is additive and never modifies native products/orders or embeds credentials', async () => {
  const statements = []; await migration({ query: async (sql) => { statements.push(sql); } });
  assert.equal(statements.length, 4);
  assert.ok(statements.every((sql) => /^CREATE TABLE IF NOT EXISTS shusha_bridge_/.test(sql)));
  assert.equal(statements.some((sql) => /\b(DROP|DELETE|UPDATE|INSERT)\b/i.test(sql)), false);
  assert.ok(statements.some((sql) => /delivery_id text PRIMARY KEY/.test(sql)));
  assert.ok(statements.some((sql) => /nonce text PRIMARY KEY/.test(sql)));
});

test('native middleware dependency order preserves original bytes and private OAuth route access', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const parser = parseFromFile(path.join(root, 'api/shopifyWebhook/[context]bodyParser[verify].js'))[0];
  const verifier = parseFromFile(path.join(root, 'api/shopifyWebhook/[bodyParser]verify.js'))[0];
  const globals = ['context', 'getCurrentUser', 'auth', 'apiResponse'].map((id) => ({ id, scope: 'app', region: 'api', routeId: null }));
  const sorted = sortMiddlewares([...globals, verifier, parser]);
  const ids = sorted.map((entry) => entry.id); assert.ok(ids.indexOf('context') < ids.indexOf('bodyParser')); assert.ok(ids.indexOf('bodyParser') < ids.indexOf('verify')); assert.ok(ids.indexOf('verify') < ids.indexOf('apiResponse'));
  for (const route of ['shopifyOAuthStart', 'shopifyOAuthCallback', 'shopifyStatus']) {
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'api', route, 'route.json'), 'utf8'));
    assert.equal(metadata.access, 'private'); assert.deepEqual(metadata.methods, ['GET']);
    const middleware = parseFromFile(path.join(root, 'api', route, route === 'shopifyOAuthStart' ? '[auth]start.js' : route === 'shopifyOAuthCallback' ? '[auth]callback.js' : '[auth]status.js'))[0];
    assert.ok(middleware.after.includes('auth'));
  }
});

test('real raw-parser HTTP pipeline verifies literal whitespace bytes and rejects compressed or oversized bodies', async (t) => {
  const secret = 'synthetic-webhook-secret'; const app = express(); let observed;
  app.post('/synthetic-webhook', rawParser, (request, response) => {
    observed = request.body;
    response.status(verifyWebhookHmac(request.body, request.get('X-Shopify-Hmac-Sha256'), secret) ? 200 : 401).end();
  });
  app.use((error, request, response, next) => { response.status(error.status || 500).end(); });
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/synthetic-webhook`;
  const body = '{ "id":1, "value":"synthetic" }'; const signature = createHmac('sha256', secret).update(body).digest('base64');
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': signature }, body })).status, 200);
  assert.equal(Buffer.isBuffer(observed), true); assert.equal(observed.toString('utf8'), body);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': signature }, body: body.replace(' ', '') })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: 'synthetic' })).status, 415);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(2 * 1024 * 1024 + 1) })).status, 413);
});

test('actual native status and OAuth wrappers stop before eNext and bind uninstall identity to the verified installed shop', async () => {
  const source = fileURLToPath(new URL('../src/api/', import.meta.url));
  const poolParent = pathToFileURL(path.join(source, 'shopifyStatus/[auth]status.js')).href;
  const runtimeParents = new Set(['shopifyOAuthStart/[auth]start.js', 'shopifyOAuthCallback/[auth]callback.js'].map(route => pathToFileURL(path.join(source, route)).href));
  const slot = Symbol.for('shusha.bridge.native-wrapper.synthetic');
  const shop = 'synthetic-native-wrapper.myshopify.com';
  const config = { enabled: true, shop, clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret', scopes: ['read_products'], redirectUri: 'https://synthetic-app.example/api/shopify/oauth/callback' };
  const merchant = { uuid: 'synthetic-merchant-session-uuid' };
  const operations = new Map(); const nonces = new Set(); const exchanges = [];
  let installedShop = { id: 'gid://shopify/Shop/321', myshopifyDomain: shop };
  let failPool = false; let advanced = 0;
  const fixture = {
    pool: { async query(sql) { if (failPool) throw new Error('synthetic private database failure'); return { rows: [{ n: sql.includes('shusha_bridge_token') ? 1 : 3 }] }; } },
    runtime: { config, repositories: {
      async consumeNonce(nonce) { if (nonces.has(nonce)) return false; nonces.add(nonce); return true; },
      mappings: { async saveOperation(key, value) { operations.set(key, value); } }
    }, tokens: { async exchangeCode(code) { exchanges.push(code); } },
    client: { async request(document) { assert.match(document, /shop\s*\{\s*id myshopifyDomain/); return { shop: installedShop }; } } }
  };
  // Only the real route sources' native DB/runtime imports are replaced. The native
  // wrapper, route handlers, HMAC/state verification and HTTP response methods run unchanged.
  globalThis[slot] = fixture;
  const stub = exportText => `data:text/javascript,${encodeURIComponent(`const fixture = globalThis[Symbol.for('shusha.bridge.native-wrapper.synthetic')]; ${exportText}`)}`;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    const parent = context.parentURL?.split('?')[0];
    if (specifier === '@evershop/evershop/lib/postgres' && parent === poolParent) return { url: stub('export const pool = fixture.pool;'), shortCircuit: true };
    if (specifier === '../../services/runtime.js' && runtimeParents.has(parent)) return { url: stub('export function bridgeRuntime() { return fixture.runtime; }'), shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  const app = express();
  app.use((request, response, next) => { response.debugMiddlewares = []; request.getCurrentUser = () => request.get('X-Synthetic-Admin') === 'yes' ? merchant : null; next(); });
  for (const [route, id, filename] of [['status', 'status', 'shopifyStatus/[auth]status.js'], ['start', 'start', 'shopifyOAuthStart/[auth]start.js'], ['callback', 'callback', 'shopifyOAuthCallback/[auth]callback.js']]) {
    app.get(`/${route}`, buildMiddlewareFunction(id, path.join(source, filename)), (request, response) => { advanced++; if (!response.headersSent) response.status(500).json({ error: 'NATIVE_RESPONSE_CONTINUED' }); });
  }
  app.use((error, request, response, next) => { advanced++; if (!response.headersSent) response.status(500).json({ error: 'SYNTHETIC_WRAPPER_FAILURE' }); });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchRoute = route => fetch(`${base}/${route}`, { headers: { 'X-Synthetic-Admin': 'yes' }, redirect: 'manual' });
  const callbackQuery = (state = createOAuthState({ shop, sessionId: merchant.uuid, secret: config.clientSecret })) => {
    const query = { code: 'synthetic-offline-authorization-code', shop, state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const message = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
    return new URLSearchParams({ ...query, hmac: createHmac('sha256', config.clientSecret).update(message).digest('hex') }).toString();
  };
  try {
    const status = await fetchRoute('status'); assert.equal(status.status, 200); assert.match(status.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await status.json(), { data: { enabled: process.env.SHOPIFY_BRIDGE_ENABLED === 'true', writesEnabled: process.env.SHOPIFY_BRIDGE_WRITES_ENABLED === 'true', connected: true, mappedStyles: 3 } });
    failPool = true; const unavailable = await fetchRoute('status'); assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), { error: 'SHOPIFY_BRIDGE_NOT_MIGRATED' }); failPool = false;
    const start = await fetchRoute('start'); assert.equal(start.status, 302); assert.match(start.headers.get('cache-control'), /no-store/);
    const authorization = new URL(start.headers.get('location')); assert.equal(authorization.host, shop); assert.equal(authorization.searchParams.get('redirect_uri'), config.redirectUri); assert.ok(authorization.searchParams.get('state'));
    assert.equal((await fetch(`${base}/start`, { redirect: 'manual' })).status, 401);
    const signedQuery = callbackQuery(); const callback = await fetchRoute(`callback?${signedQuery}`);
    assert.equal(callback.status, 302); assert.equal(callback.headers.get('location'), '/admin/shopify-bridge?authorized=1'); assert.match(callback.headers.get('cache-control'), /no-store/);
    assert.deepEqual(operations.get(`installation:${shop}`), { kind: 'installation', status: 'complete', shop, shopId: '321' });
    assert.equal(exchanges.length, 1);
    assert.equal((await fetchRoute(`callback?${signedQuery}`)).status, 400); assert.equal(exchanges.length, 1);
    operations.clear(); installedShop = { id: 'gid://shopify/Shop/999', myshopifyDomain: 'synthetic-foreign.myshopify.com' };
    const wrongShop = await fetchRoute(`callback?${callbackQuery()}`); assert.equal(wrongShop.status, 400); assert.deepEqual(await wrongShop.json(), { error: 'SHOPIFY_AUTHORIZATION_FAILED' }); assert.equal(operations.size, 0);
    installedShop = { id: 'gid://shopify/Product/321', myshopifyDomain: shop };
    assert.equal((await fetchRoute(`callback?${callbackQuery()}`)).status, 400); assert.equal(operations.size, 0);
    assert.equal(advanced, 0, 'terminal actual handlers must never advance native eNext/default response after sending');
  } finally {
    await new Promise(resolve => server.close(resolve)); hooks.deregister(); delete globalThis[slot];
  }
});
