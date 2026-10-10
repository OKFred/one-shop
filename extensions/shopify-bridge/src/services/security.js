import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeShop } from './config.js';

export function constantTimeEqual(actual, expected) {
  const a = Buffer.isBuffer(actual) ? actual : Buffer.from(String(actual));
  const b = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmac(secret, message, encoding = 'hex') { return createHmac('sha256', secret).update(message).digest(encoding); }

export function verifyOAuthHmac(query, secret) {
  const entries = query instanceof URLSearchParams ? [...query.entries()] : Object.entries(query || {});
  if (new Set(entries.map(([key]) => key)).size !== entries.length || entries.some(([, value]) => typeof value !== 'string')) return false;
  const received = entries.find(([key]) => key === 'hmac')?.[1];
  if (!/^[a-f0-9]{64}$/.test(received || '')) return false;
  const message = entries.filter(([key]) => key !== 'hmac').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
  return constantTimeEqual(received, hmac(secret, message));
}

export function verifyWebhookHmac(rawBody, received, secret) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > 2 * 1024 * 1024 || typeof received !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(received)) return false;
  return constantTimeEqual(received, hmac(secret, rawBody, 'base64'));
}

export function createOAuthState({ shop, sessionId, secret, now = Date.now, ttlMs = 10 * 60 * 1000 }) {
  normalizeShop(shop);
  if (typeof sessionId !== 'string' || sessionId.length < 16 || !secret) throw new Error('OAuth state requires an authenticated session and secret');
  const payload = { v: 1, shop, session: createHash('sha256').update(sessionId).digest('hex'), nonce: randomBytes(32).toString('base64url'), exp: now() + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${hmac(secret, encoded, 'base64url')}`;
}

export async function consumeOAuthState(token, { shop, sessionId, secret, consumeNonce, now = Date.now }) {
  if (typeof token !== 'string' || token.length > 2048 || typeof consumeNonce !== 'function') throw new Error('Invalid OAuth state');
  const parts = token.split('.');
  if (parts.length !== 2 || !constantTimeEqual(parts[1], hmac(secret, parts[0], 'base64url'))) throw new Error('Invalid OAuth state');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) { throw new Error('Invalid OAuth state'); }
  if (payload.v !== 1 || payload.shop !== normalizeShop(shop) || !Number.isSafeInteger(payload.exp) || payload.exp <= now() || payload.exp > now() + 10 * 60 * 1000 ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce || '') || !constantTimeEqual(payload.session, createHash('sha256').update(sessionId).digest('hex'))) {
    throw new Error('Expired or mismatched OAuth state');
  }
  // Repository performs atomic INSERT with a unique nonce; false means replay.
  if (await consumeNonce(payload.nonce, payload.exp) !== true) throw new Error('OAuth state has already been consumed');
  return payload;
}

export function createAuthorizationUrl(config, { state }) {
  if (!config.enabled || typeof state !== 'string' || !state) throw new Error('OAuth is not configured');
  return `https://${normalizeShop(config.shop)}/admin/oauth/authorize?${new URLSearchParams({ client_id: config.clientId, scope: config.scopes.join(','), redirect_uri: config.redirectUri, state })}`;
}

export function validateWebhookEnvelope({ shop, expectedShop, topic, allowedTopics, deliveryId }) {
  if (normalizeShop(shop) !== expectedShop || !allowedTopics.includes(topic) || !/^[a-zA-Z0-9-]{16,128}$/.test(deliveryId || '')) throw new Error('Unexpected Shopify webhook envelope');
  return { shop, topic, deliveryId };
}
