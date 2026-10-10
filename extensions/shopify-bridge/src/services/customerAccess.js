import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { normalizeShop } from './config.js';
import { assertQuoteMatchesCurrent, readLivePaymentOrder, paymentOrderId, decimalMoney } from './payments.js';

function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function parsePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part || '')) throw new Error('Invalid signed credential');
  const bytes = Buffer.from(part, 'base64url'); if (bytes.toString('base64url') !== part) throw new Error('Invalid signed credential');
  let parsed; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid signed credential'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid signed credential'); return parsed;
}
function verifyJwt(token, secret) {
  if (typeof token !== 'string' || token.length > 8192 || typeof secret !== 'string' || secret.length < 16) throw new Error('Invalid signed credential');
  const parts = token.split('.'); if (parts.length !== 3) throw new Error('Invalid signed credential');
  const header = parsePart(parts[0]);
  if (header.alg !== 'HS256' || (header.typ && header.typ !== 'JWT') || header.crit || header.jwk || header.jku || header.x5u) throw new Error('Unsupported signed credential');
  const signature = Buffer.from(parts[2], 'base64url'), expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret), 'base64url');
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[2]) || signature.toString('base64url') !== parts[2] || signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error('Invalid signed credential');
  return parsePart(parts[1]);
}
function customerId(value) { if (typeof value !== 'string' || !/^gid:\/\/shopify\/Customer\/\d+$/.test(value)) throw new Error('A fully signed-in customer is required'); return value; }
function tokenTimes(payload, nowSeconds) {
  if (![payload.exp, payload.nbf, payload.iat].every(Number.isSafeInteger) || payload.exp <= nowSeconds || payload.nbf > nowSeconds || payload.iat > nowSeconds || payload.iat < nowSeconds - 300 || payload.exp - payload.iat > 300 || payload.exp <= payload.iat || payload.nbf < payload.iat || payload.nbf >= payload.exp) throw new Error('Expired or future signed credential');
}
function destination(value) {
  if (typeof value !== 'string') throw new Error('Invalid credential store');
  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) return normalizeShop(value);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Invalid credential store');
  return normalizeShop(parsed.hostname);
}
export function verifyCustomerSessionToken(token, { appSecret, clientId, shop, now = Date.now } = {}) {
  const payload = verifyJwt(token, appSecret); tokenTimes(payload, Math.floor(now() / 1000));
  if (payload.aud !== clientId || destination(payload.dest) !== normalizeShop(shop)) throw new Error('Customer credential belongs to another app or store');
  customerId(payload.sub);
  return { customerId: payload.sub, shop, expiresAt: payload.exp * 1000 };
}
function makeJwt(payload, secret) { const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'); const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${header}.${body}.${sign(`${header}.${body}`, secret)}`; }
export function createCustomerPaymentAccess({ shop, client, repository, appSecret, clientId, accessSecret, appUrl, allowedManualGateways = [], now = Date.now } = {}) {
  normalizeShop(shop);
  if (typeof repository?.getQuote !== 'function' || typeof repository?.withOrderLock !== 'function' || typeof client?.request !== 'function' || typeof clientId !== 'string' || !clientId || typeof appSecret !== 'string' || appSecret.length < 16 || typeof accessSecret !== 'string' || accessSecret.length < 32 || accessSecret === appSecret) throw new Error('Private customer payment authentication is not configured');
  const origin = new URL(appUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Customer payment URL must be the verified HTTPS app origin');
  async function validated(orderId, customer) {
    await repository.assertOrderOperable?.(paymentOrderId(orderId));
    const order = await readLivePaymentOrder(client, shop, paymentOrderId(orderId));
    if (order.customer?.id !== customer) throw new Error('Customer does not own this order');
    const quote = await repository.getQuote(orderId); assertQuoteMatchesCurrent(quote, order, { shop, allowedManualGateways });
    if (!['confirmed', 'partial'].includes(quote.status) || !Number.isSafeInteger(quote.paymentVersion) || quote.paymentVersion < 1) throw new Error('Payment is awaiting confirmation or has already been received');
    decimalMoney(quote.remainingAmount);
    return quote;
  }
  async function issue(sessionToken, orderId) {
    const session = verifyCustomerSessionToken(sessionToken, { appSecret, clientId, shop, now });
    const id = paymentOrderId(orderId);
    return repository.withOrderLock(id, async () => {
      // A cancellation/receipt/quote change cannot race the authorized snapshot.
      // Credentials can expire while another merchant operation holds the lock.
      verifyCustomerSessionToken(sessionToken, { appSecret, clientId, shop, now });
      const quote = await validated(id, session.customerId); const timestamp = Math.floor(now() / 1000);
      verifyCustomerSessionToken(sessionToken, { appSecret, clientId, shop, now });
      const payload = { v: 1, purpose: 'shusha-shopify-payment', iss: origin.origin, aud: 'shusha-payment-page', shop, orderId: id, sub: session.customerId, quoteRevision: quote.revision, paymentVersion: quote.paymentVersion, iat: timestamp, nbf: timestamp, exp: timestamp + 300, jti: randomBytes(24).toString('base64url') };
      const access = makeJwt(payload, accessSecret);
      return { paymentUrl: `${origin.origin}/shopify/payment?access=${encodeURIComponent(access)}`, expiresAt: payload.exp * 1000, quoteRevision: quote.revision };
    });
  }
  async function redeem(access) {
    const payload = verifyJwt(access, accessSecret); tokenTimes(payload, Math.floor(now() / 1000));
    if (payload.v !== 1 || payload.purpose !== 'shusha-shopify-payment' || payload.iss !== origin.origin || payload.aud !== 'shusha-payment-page' || payload.shop !== shop || !Number.isSafeInteger(payload.quoteRevision) || !Number.isSafeInteger(payload.paymentVersion)) throw new Error('Invalid payment credential');
    return repository.withOrderLock(paymentOrderId(payload.orderId), async () => {
      tokenTimes(payload, Math.floor(now() / 1000));
      const quote = await validated(payload.orderId, customerId(payload.sub));
      if (quote.revision !== payload.quoteRevision || quote.paymentVersion !== payload.paymentVersion) throw new Error('Payment quote changed; request a new payment entry');
      tokenTimes(payload, Math.floor(now() / 1000));
      // Returned only by the authorized, no-store payment route. Do not expose
      // this object through admin GraphQL, logs, a theme metafield or a webhook.
      return { quote: { status: quote.status, revision: quote.revision, currency: quote.currency, amount: quote.remainingAmount, reference: quote.reference, wisePaymentUrl: quote.wisePaymentUrl, bankDetails: quote.bankDetails }, expiresAt: payload.exp * 1000 };
    });
  }
  return Object.freeze({ issue, redeem });
}
