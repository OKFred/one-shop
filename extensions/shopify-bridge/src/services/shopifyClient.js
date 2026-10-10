import { createHash } from 'node:crypto';
import { API_VERSION, normalizeShop } from './config.js';

export class ShopifyRequestError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ShopifyRequestError'; this.code = code; Object.assign(this, details); }
}
export class UnknownMutationOutcomeError extends ShopifyRequestError {
  constructor(details = {}) { super('SHOPIFY_MUTATION_OUTCOME_UNKNOWN', 'Shopify mutation outcome is unknown; reconcile or retry the original persisted idempotent request', details); this.name = 'UnknownMutationOutcomeError'; }
}

function operationKind(document) {
  const source = document.replace(/#[^\r\n]*/g, '').trim();
  if (/^mutation\b/.test(source)) return 'mutation';
  if (/^(query\b|\{)/.test(source)) return 'query';
  throw new Error('Admin request must start with one explicit query or mutation');
}

function retryDelay(response, attempt, body, now) {
  const retryAfter = response?.headers?.get('retry-after');
  const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 0;
  const dateDelay = retryAfter && !seconds ? Math.max(0, Date.parse(retryAfter) - now()) : 0;
  const cost = body?.extensions?.cost;
  const available = cost?.throttleStatus?.currentlyAvailable;
  const restore = cost?.throttleStatus?.restoreRate;
  const requested = cost?.requestedQueryCost;
  const costDelay = Number.isFinite(available) && Number.isFinite(restore) && restore > 0 && Number.isFinite(requested)
    ? Math.max(0, (requested - available) / restore * 1000) : 0;
  return Math.min(30000, Math.max(250 * 2 ** attempt, seconds * 1000, dateDelay || 0, costDelay));
}

async function boundedJson(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Response exceeds bounds');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is missing');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Response exceeds bounds'); }
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export function createShopifyClient({ shop, getAccessToken, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, maxAttempts = 4, timeoutMs = 30000 }) {
  normalizeShop(shop);
  if (typeof getAccessToken !== 'function' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('Invalid Shopify transport configuration');
  const endpoint = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  async function request(document, variables = {}, options = {}) {
    if (typeof document !== 'string' || document.length > 100000) throw new Error('Invalid Admin GraphQL document');
    const kind = operationKind(document);
    if (options.kind && options.kind !== kind) throw new Error('GraphQL operation kind mismatch');
    const bodyText = JSON.stringify({ query: document, variables });
    if (Buffer.byteLength(bodyText) > 2 * 1024 * 1024) throw new Error('Admin request exceeds bounded payload size');
    const requestHash = createHash('sha256').update(bodyText).digest('hex');
    const details = { requestHash, idempotencyKey: options.idempotencyKey ?? null };
    // Idempotency is implemented by mutation-specific persisted input/directives,
    // not an invented HTTP header. Unknown generic writes are never replayed.
    const replaySafe = kind === 'query' || (options.safeRetry === true && typeof options.idempotencyKey === 'string' && options.idempotencyKey.length > 0);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const token = await getAccessToken();
      let response;
      try {
        response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token }, body: bodyText, signal: AbortSignal.timeout(timeoutMs) });
      } catch (_) {
        if (kind === 'mutation' && !replaySafe) throw new UnknownMutationOutcomeError(details);
        if (attempt + 1 === maxAttempts) throw kind === 'mutation' ? new UnknownMutationOutcomeError(details) : new ShopifyRequestError('SHOPIFY_UNREACHABLE', 'Shopify query could not be completed');
        await sleep(retryDelay(null, attempt, null, now)); continue;
      }
      const requestId = response.headers.get('x-request-id');
      const version = response.headers.get('x-shopify-api-version');
      if (version && version !== API_VERSION) {
        if (kind === 'mutation') throw new UnknownMutationOutcomeError({ ...details, requestId, apiVersionMismatch: true });
        throw new ShopifyRequestError('SHOPIFY_API_VERSION_MISMATCH', 'Shopify returned an unreviewed API version', { requestId });
      }
      if (response.status === 401 || response.status === 403) throw new ShopifyRequestError('SHOPIFY_AUTHORIZATION', 'Shopify API permission or installation must be reviewed', { status: response.status, requestId });
      if (response.status === 429) {
        if (attempt + 1 < maxAttempts) { await sleep(retryDelay(response, attempt, null, now)); continue; }
        throw new ShopifyRequestError('SHOPIFY_THROTTLED', 'Shopify rate limit retry budget exhausted', { requestId });
      }
      if (response.status >= 500) {
        if (!replaySafe) throw new UnknownMutationOutcomeError({ ...details, requestId });
        if (attempt + 1 < maxAttempts) { await sleep(retryDelay(response, attempt, null, now)); continue; }
        throw kind === 'mutation' ? new UnknownMutationOutcomeError({ ...details, requestId }) : new ShopifyRequestError('SHOPIFY_UNAVAILABLE', 'Shopify query retry budget exhausted', { requestId });
      }
      if (!response.ok) throw new ShopifyRequestError('SHOPIFY_HTTP_REJECTED', `Shopify request rejected (${response.status})`, { status: response.status, requestId });
      let body;
      try {
        body = await boundedJson(response, 10 * 1024 * 1024);
      } catch (_) {
        if (kind === 'mutation') throw new UnknownMutationOutcomeError({ ...details, requestId });
        throw new ShopifyRequestError('SHOPIFY_INVALID_RESPONSE', 'Shopify query returned an invalid bounded response', { requestId });
      }
      if (Array.isArray(body.errors) && body.errors.length) {
        const codes = body.errors.map((error) => error.extensions?.code || 'UNKNOWN');
        const throttled = codes.every((code) => code === 'THROTTLED') && !body.data;
        if (throttled && attempt + 1 < maxAttempts) { await sleep(retryDelay(response, attempt, body, now)); continue; }
        if (throttled) throw new ShopifyRequestError('SHOPIFY_THROTTLED', 'Shopify GraphQL retry budget exhausted', { requestId });
        const rejected = !body.data && codes.every((code) => ['GRAPHQL_VALIDATION_FAILED', 'ACCESS_DENIED', 'MAX_COST_EXCEEDED'].includes(code));
        if (kind === 'mutation' && !rejected) throw new UnknownMutationOutcomeError({ ...details, requestId });
        // API error text may echo private variables. Export only stable codes.
        throw new ShopifyRequestError('SHOPIFY_GRAPHQL_ERROR', 'Shopify GraphQL request requires review', { codes, requestId });
      }
      if (!body.data || typeof body.data !== 'object') throw kind === 'mutation' ? new UnknownMutationOutcomeError({ ...details, requestId }) : new ShopifyRequestError('SHOPIFY_INVALID_RESPONSE', 'Shopify query returned no data');
      return body.data;
    }
    throw new ShopifyRequestError('SHOPIFY_RETRY_EXHAUSTED', 'Shopify retry budget exhausted');
  }
  async function uploadStaged(target, bytes, { filename, mimeType }) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 20 * 1024 * 1024 || !/^[a-zA-Z0-9._-]{1,180}$/.test(filename || '') || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('Invalid bounded staged image');
    const url = new URL(target.url);
    // Staged credentials are only sent to Shopify's documented storage hosts.
    if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'shopify-staged-uploads.storage.googleapis.com' || url.hostname.endsWith('.storage.googleapis.com') || url.hostname.endsWith('.s3.amazonaws.com') || url.hostname === 'storage.googleapis.com')) throw new Error('Unexpected Shopify staged upload host');
    if (!Array.isArray(target.parameters) || target.parameters.length > 30) throw new Error('Invalid staged upload parameters');
    const form = new FormData();
    for (const parameter of target.parameters) {
      if (typeof parameter.name !== 'string' || typeof parameter.value !== 'string' || parameter.name === 'file') throw new Error('Invalid staged upload parameter');
      form.append(parameter.name, parameter.value);
    }
    form.append('file', new Blob([bytes], { type: mimeType }), filename);
    let response;
    try { response = await fetchImpl(url, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch (_) { throw new ShopifyRequestError('SHOPIFY_STAGED_UPLOAD_RETRY', 'Staged image upload did not complete; product was not attached'); }
    if (!response.ok) throw new ShopifyRequestError('SHOPIFY_STAGED_UPLOAD_REJECTED', `Staged image upload rejected (${response.status})`);
    return true;
  }
  return Object.freeze({ shop, apiVersion: API_VERSION, request, uploadStaged });
}
