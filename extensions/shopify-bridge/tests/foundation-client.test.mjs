import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyClient, UnknownMutationOutcomeError } from '../src/services/shopifyClient.js';

const defaults = { shop: 'synthetic-shop.myshopify.com', getAccessToken: async () => 'synthetic-access', sleep: async () => {} };
const ok = (data = { shop: { currencyCode: 'USD' } }) => new Response(JSON.stringify({ data }), { headers: { 'x-shopify-api-version': '2026-10' } });

test('Admin GraphQL pins 2026-10, uses server header, bounded query retries and no credential diagnostics', async () => {
  const calls = []; const sleeps = [];
  const client = createShopifyClient({ ...defaults, sleep: async (ms) => sleeps.push(ms), fetchImpl: async (url, options) => {
    calls.push({ url, options }); if (calls.length === 1) return new Response('', { status: 500 });
    if (calls.length === 2) return new Response('', { status: 429, headers: { 'retry-after': '2' } }); return ok();
  } });
  assert.deepEqual(await client.request('query Shop{shop{currencyCode}}'), { shop: { currencyCode: 'USD' } });
  assert.equal(calls.length, 3); assert.match(calls[0].url, /\/2026-10\/graphql\.json$/); assert.equal(calls[0].options.headers['X-Shopify-Access-Token'], 'synthetic-access'); assert.equal(sleeps[1], 2000);
  await assert.rejects(client.request('mutation X{productCreate(product:{title:"x"}){product{id}}}', {}, { kind: 'query' }), /kind mismatch/);
});

test('lost generic mutation response is unknown, never retried; persisted idempotent requests repeat identical body', async () => {
  let calls = 0;
  const client = createShopifyClient({ ...defaults, fetchImpl: async () => { calls++; throw new Error('synthetic transport drop'); } });
  await assert.rejects(client.request('mutation Write{fake{id}}', { synthetic: true }), UnknownMutationOutcomeError);
  assert.equal(calls, 1);
  const bodies = [];
  const retry = createShopifyClient({ ...defaults, fetchImpl: async (_, options) => { bodies.push(options.body); if (bodies.length === 1) throw new Error('drop'); return ok({ fake: { id: 'synthetic' } }); } });
  await retry.request('mutation Write{fake{id}}', { synthetic: true }, { safeRetry: true, idempotencyKey: 'synthetic-original-key' });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});

test('throttle cost retries before execution; partial mutation errors remain unknown without exposed server text', async () => {
  let calls = 0; const sleeps = [];
  const client = createShopifyClient({ ...defaults, sleep: async (ms) => sleeps.push(ms), fetchImpl: async () => {
    calls++; return calls === 1 ? new Response(JSON.stringify({ errors: [{ message: 'synthetic-private-text', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 100, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } } })) : ok({ fake: { id: 'synthetic' } });
  } });
  await client.request('mutation Write{fake{id}}'); assert.equal(calls, 2); assert.equal(sleeps[0], 2000);
  const partial = createShopifyClient({ ...defaults, fetchImpl: async () => new Response(JSON.stringify({ data: { fake: null }, errors: [{ message: 'synthetic-secret', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })) });
  await assert.rejects(partial.request('mutation Write{fake{id}}'), (error) => error.code === 'SHOPIFY_MUTATION_OUTCOME_UNKNOWN' && !error.message.includes('synthetic-secret'));
});

test('version fallback, authorization failure and query retry budget fail explicitly', async () => {
  const version = createShopifyClient({ ...defaults, fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { headers: { 'x-shopify-api-version': '2027-01' } }) });
  await assert.rejects(version.request('query Q{shop{id}}'), { code: 'SHOPIFY_API_VERSION_MISMATCH' });
  const denied = createShopifyClient({ ...defaults, fetchImpl: async () => new Response('', { status: 403 }) });
  await assert.rejects(denied.request('query Q{shop{id}}'), { code: 'SHOPIFY_AUTHORIZATION' });
  let calls = 0; const bounded = createShopifyClient({ ...defaults, maxAttempts: 3, fetchImpl: async () => { calls++; return new Response('', { status: 500 }); } });
  await assert.rejects(bounded.request('query Q{shop{id}}'), { code: 'SHOPIFY_UNAVAILABLE' }); assert.equal(calls, 3);
});

test('staged upload sends multipart originals without access token, rejects foreign hosts and redirects', async () => {
  let options;
  const client = createShopifyClient({ ...defaults, fetchImpl: async (_, input) => { options = input; return new Response('', { status: 201 }); } });
  const target = { url: 'https://shopify-staged-uploads.storage.googleapis.com/', parameters: [{ name: 'key', value: 'synthetic-object' }] };
  await client.uploadStaged(target, Buffer.from('synthetic-image'), { filename: 'synthetic.png', mimeType: 'image/png' });
  assert.equal(options.body instanceof FormData, true); assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error');
  await assert.rejects(client.uploadStaged({ ...target, url: 'https://evil.test/' }, Buffer.from('image'), { filename: 'synthetic.png', mimeType: 'image/png' }), /host/);
});
