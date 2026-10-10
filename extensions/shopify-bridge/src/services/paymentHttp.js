import bodyParser from 'body-parser';
import { createHash } from 'node:crypto';
import { publicQuoteSummary } from './paymentRuntime.js';
import { renderPaymentPage, renderUnavailablePaymentPage, paymentPageCsp } from './paymentPage.js';

export function privatePaymentHeaders(response) {
  response.set('Cache-Control', 'private, no-store, max-age=0');
  response.set('Pragma', 'no-cache'); response.set('Expires', '0');
  response.set('Referrer-Policy', 'no-referrer');
  response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  response.set('X-Content-Type-Options', 'nosniff');
}
function jsonObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
export function createPaymentAccessLimiter({ now = Date.now, windowMs = 60000, perToken = 30, perAddress = 240, maxEntries = 10000 } = {}) {
  const windows = new Map();
  const hashed = value => createHash('sha256').update(value).digest('hex');
  return ({ token, address }) => {
    const timestamp = now();
    const keys = [[`token:${hashed(token)}`, perToken], [`address:${hashed(address || 'unknown')}`, perAddress]];
    for (const [key, limit] of keys) {
      const value = windows.get(key);
      if (value?.expiresAt > timestamp && value.count >= limit) return false;
    }
    if (windows.size + keys.filter(([key]) => !windows.has(key)).length > maxEntries) for (const [key, value] of windows) if (value.expiresAt <= timestamp) windows.delete(key);
    if (windows.size + keys.filter(([key]) => !windows.has(key)).length > maxEntries) return false;
    for (const [key] of keys) {
      const previous = windows.get(key);
      windows.set(key, previous?.expiresAt > timestamp ? { ...previous, count: previous.count + 1 } : { count: 1, expiresAt: timestamp + windowMs });
    }
    return true;
  };
}
const customerAccessLimit = createPaymentAccessLimiter();
export function paymentJsonBody({ customer = false } = {}) {
  const parser = bodyParser.json({ type: 'application/json', inflate: false, limit: '16kb', strict: true });
  return (request, response, next) => {
    privatePaymentHeaders(response);
    if (customer) {
      // Customer account extensions have sandboxed/null origins. Shopify's
      // required wildcard applies only to this bearer-authenticated endpoint;
      // cookies never grant access and credentialed CORS is not enabled.
      response.set('Access-Control-Allow-Origin', '*');
      response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      if (request.method === 'OPTIONS') {
        if (request.get('Access-Control-Request-Method') !== 'POST' || (request.get('Access-Control-Request-Headers') || '').split(',').filter(Boolean).some(header => !['authorization', 'content-type'].includes(header.trim().toLowerCase()))) return response.status(403).json({ error: { code: 'INVALID_PREFLIGHT' } });
        return response.status(204).end();
      }
    }
    if (!request.is('application/json')) return response.status(415).json({ error: { code: 'JSON_REQUIRED' } });
    return parser(request, response, error => {
      if (error) return response.status(error.status === 413 ? 413 : 400).json({ error: { code: 'INVALID_PAYMENT_REQUEST' } });
      if (!jsonObject(request.body)) return response.status(400).json({ error: { code: 'INVALID_PAYMENT_REQUEST' } });
      return next();
    });
  };
}
// EverShop auto-advances handlers with arity two, even after a response is sent.
// These terminal handlers intentionally accept next and never call it.
export function createAdminPaymentHandler({ getRuntime }) {
  return async (request, response, next) => {
    privatePaymentHeaders(response);
    if (!request.getCurrentUser?.()?.uuid) return response.status(401).json({ error: { code: 'ADMIN_REQUIRED' } });
    try {
      const runtime = await getRuntime();
      if (request.get('Origin') !== runtime.config.appUrl) return response.status(403).json({ error: { code: 'SAME_ORIGIN_REQUIRED' } });
      const body = request.body;
      if (!jsonObject(body) || Object.keys(body).some(key => !['action', 'input'].includes(key)) || !jsonObject(body.input)) return response.status(400).json({ error: { code: 'INVALID_PAYMENT_REQUEST' } });
      const actions = {
        inspect: input => runtime.inspect(input.orderId),
        'confirm-quote': input => runtime.payments.confirmShippingQuote(input),
        'record-receipt': input => runtime.payments.recordReceipt(input),
        'mark-paid': input => runtime.payments.markPaid(input),
        fulfill: input => runtime.fulfillment.fulfill(input),
        'reconcile-paid': input => runtime.payments.reconcilePaid(input.operationKey),
        'reconcile-fulfillment': input => runtime.fulfillment.reconcile(input.operationKey)
      };
      if (!Object.hasOwn(actions, body.action)) return response.status(400).json({ error: { code: 'INVALID_PAYMENT_ACTION' } });
      const result = ['confirm-quote', 'record-receipt', 'mark-paid', 'fulfill'].includes(body.action)
        ? await runtime.repository.withOrderLock(body.input.orderId, async () => {
          await runtime.repository.assertOrderOperable(body.input.orderId);
          return actions[body.action](body.input);
        }) : await actions[body.action](body.input);
      if (body.action === 'inspect') return response.status(200).json({ data: result });
      const safe = {};
      for (const key of ['alreadyComplete', 'nativeVerified', 'customerNotified', 'alreadyRecorded', 'nativeMarkedPaid', 'requiresExplicitMarkPaid', 'alreadyPaidInNative', 'unresolved', 'replayed', 'fulfillmentId']) if (result[key] !== undefined) safe[key] = result[key];
      if (result.quote) safe.quote = publicQuoteSummary(result.quote);
      return response.status(200).json({ data: safe });
    } catch {
      // Never serialize provider/SQL/config exceptions, private receiving fields,
      // request payloads, receipts or tokens into error responses.
      return response.status(409).json({ error: { code: 'SHOPIFY_PAYMENT_OPERATION_REVIEW', message: 'The operation needs review. Check the current quote and original operation journal before retrying.' } });
    }
  };
}
export function createCustomerPaymentHandler({ getRuntime, allowRequest = customerAccessLimit }) {
  return async (request, response, next) => {
    privatePaymentHeaders(response);
    response.set('Access-Control-Allow-Origin', '*');
    const authorization = request.get('Authorization');
    const token = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization)?.[1];
    if (!token) return response.status(401).json({ error: { code: 'SIGNED_CUSTOMER_REQUIRED' } });
    if (!jsonObject(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.orderId !== 'string') return response.status(400).json({ error: { code: 'INVALID_PAYMENT_REQUEST' } });
    if (!allowRequest({ token, address: request.socket?.remoteAddress })) {
      response.set('Retry-After', '60');
      return response.status(429).json({ error: { code: 'PAYMENT_ACCESS_RATE_LIMITED' } });
    }
    let runtime;
    try { runtime = await getRuntime(); }
    catch { return response.status(503).json({ error: { code: 'PAYMENT_ACCESS_UNAVAILABLE' } }); }
    if (!runtime.customerAccess) return response.status(503).json({ error: { code: 'PAYMENT_ACCESS_UNAVAILABLE' } });
    try { return response.status(200).json({ data: await runtime.customerAccess.issue(token, request.body.orderId) }); }
    catch (error) {
      const providerFailure = error.code && String(error.code).startsWith('SHOPIFY_');
      return response.status(providerFailure ? 503 : 403).json({ error: { code: providerFailure ? 'PAYMENT_ACCESS_UNAVAILABLE' : 'PAYMENT_ENTRY_UNAVAILABLE' } });
    }
  };
}
export function createCustomerPaymentPage({ getRuntime, allowRequest = customerAccessLimit }) {
  return async (request, response, next) => {
    privatePaymentHeaders(response);
    response.set('Content-Security-Policy', paymentPageCsp);
    response.type('html');
    const access = request.query?.access;
    if (typeof access !== 'string' || access.length > 8192 || Object.keys(request.query).length !== 1) return response.status(403).send(renderUnavailablePaymentPage());
    if (!allowRequest({ token: access, address: request.socket?.remoteAddress })) {
      response.set('Retry-After', '60');
      return response.status(429).send(renderUnavailablePaymentPage());
    }
    try {
      const runtime = await getRuntime();
      if (!runtime.customerAccess) throw new Error('Payment access is disabled');
      const redeemed = await runtime.customerAccess.redeem(access);
      return response.status(200).send(renderPaymentPage({ ...redeemed, shop: runtime.config.shop }));
    } catch {
      return response.status(403).send(renderUnavailablePaymentPage());
    }
  };
}
