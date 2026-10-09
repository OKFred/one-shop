import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAccessShippingPreferenceCart,
  createShippingPreferenceAccessMiddleware,
  shippingPreferenceIdentity
} from '../src/services/shippingPreferenceAccess.js';

const uuid = '5f51b454-c82c-4fe9-b0be-0a432d798ef7';
const guestCart = { sid: 'synthetic-session', customer_id: null, status: true };

test('Guest carts require a nonempty native session or valid signed cookie', () => {
  assert.equal(canAccessShippingPreferenceCart(guestCart, { sessionIds: ['synthetic-session'] }), true);
  assert.equal(canAccessShippingPreferenceCart(guestCart, { customerId: 12, sessionIds: ['synthetic-session'] }), true);
  assert.equal(canAccessShippingPreferenceCart(guestCart, { sessionIds: ['another-session'] }), false);
  assert.equal(canAccessShippingPreferenceCart({ ...guestCart, sid: '' }, { sessionIds: [''] }), false);
  assert.equal(canAccessShippingPreferenceCart(null, { sessionIds: ['synthetic-session'] }), false);
  assert.equal(canAccessShippingPreferenceCart({ ...guestCart, status: false }, { sessionIds: ['synthetic-session'] }), false);
});

test('Customer-bound carts require the same authenticated customer even when session matches', () => {
  const cart = { ...guestCart, customer_id: 12 };
  assert.equal(canAccessShippingPreferenceCart(cart, { customerId: 12, sessionIds: [] }), true);
  assert.equal(canAccessShippingPreferenceCart(cart, { customerId: 13, sessionIds: ['synthetic-session'] }), false);
  assert.equal(canAccessShippingPreferenceCart(cart, { customerId: null, sessionIds: ['synthetic-session'] }), false);
  assert.equal(canAccessShippingPreferenceCart({ ...cart, customer_id: 0 }, { customerId: 0, sessionIds: ['synthetic-session'] }), false);
});

test('Identity ignores spoofed checkout body, ordinary cookies and invalid signed cookies', () => {
  assert.deepEqual(shippingPreferenceIdentity({
    getCurrentCustomer: () => ({ customer_id: '12' }),
    sessionID: 'native-session',
    signedCookies: { configured_sid: 'signed-session', sid: 'wrong-name' },
    cookies: { configured_sid: 'unsigned-session' },
    body: { customer: { id: 13 } }
  }, 'configured_sid'), { customerId: 12, sessionIds: ['native-session', 'signed-session'] });
  assert.deepEqual(shippingPreferenceIdentity({
    getCurrentCustomer: () => null,
    signedCookies: { sid: false },
    cookies: { sid: 'synthetic-session' },
    body: { customer: { id: 12 } }
  }, 'sid'), { customerId: null, sessionIds: [] });
  assert.deepEqual(shippingPreferenceIdentity({
    sessionID: 'synthetic-session', signedCookies: { sid: 'synthetic-session' }
  }, 'sid'), { customerId: null, sessionIds: ['synthetic-session'] });
});

function fixture({ cart = guestCart, enabled = true, throws = false } = {}) {
  const queries = [];
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalls = 0;
  const middleware = createShippingPreferenceAccessMiddleware({
    isEnabled: async () => enabled,
    getSessionCookieName: () => 'configured_sid',
    pool: { query: async (sql, values) => {
      queries.push({ sql, values });
      if (throws) throw new Error('synthetic-private-database-detail');
      return { rows: cart ? [cart] : [] };
    } }
  });
  return { middleware, response, queries, next: () => { nextCalls += 1; }, get nextCalls() { return nextCalls; } };
}

test('Enabled checkout gates access without requiring a preference field and uses a parameterized active-cart query', async () => {
  const run = fixture();
  await run.middleware({ params: { cart_id: uuid }, signedCookies: { configured_sid: 'synthetic-session' } }, run.response, run.next);
  assert.equal(run.nextCalls, 1);
  assert.equal(run.response.body, null);
  assert.deepEqual(run.queries, [{ sql: 'SELECT sid,customer_id,status FROM cart WHERE uuid=$1 AND status=TRUE', values: [uuid] }]);
});

test('Missing, inactive, foreign and malformed carts return the same 404 response', async () => {
  for (const { cart, params } of [
    { cart: null, params: { cart_id: uuid } },
    { cart: { ...guestCart, status: false }, params: { cart_id: uuid } },
    { cart: { ...guestCart, sid: 'other-session' }, params: { cart_id: uuid } },
    { cart: { ...guestCart, customer_id: 12 }, params: { cart_id: uuid } },
    { cart: guestCart, params: { cart_id: 'not-a-uuid' } },
    { cart: guestCart, params: { cart_id: [uuid] } }
  ]) {
    const run = fixture({ cart });
    await run.middleware({ params, sessionID: 'synthetic-session' }, run.response, run.next);
    assert.equal(run.nextCalls, 0);
    assert.equal(run.response.statusCode, 404);
    assert.deepEqual(run.response.body, { error: { status: 404, message: 'Cart not found' } });
  }
});

test('Customer-bound checkout accepts only the authenticated owner, not matching sessions or body IDs', async () => {
  for (const customerId of [12, 13, null]) {
    const run = fixture({ cart: { ...guestCart, customer_id: 12 } });
    await run.middleware({
      params: { cart_id: uuid },
      sessionID: 'synthetic-session',
      body: { customer: { id: 12 } },
      getCurrentCustomer: () => customerId ? { customer_id: customerId } : null
    }, run.response, run.next);
    assert.equal(run.nextCalls, customerId === 12 ? 1 : 0);
    if (customerId !== 12) {
      assert.deepEqual(run.response.body, { error: { status: 404, message: 'Cart not found' } });
    }
  }
});

test('Disabled bank transfer leaves other checkout flows untouched', async () => {
  const run = fixture({ enabled: false });
  await run.middleware({ params: {} }, run.response, run.next);
  assert.equal(run.nextCalls, 1);
  assert.equal(run.queries.length, 0);
  assert.equal(run.response.body, null);
});

test('A failed access lookup fails closed without returning private errors', async () => {
  const run = fixture({ throws: true });
  await run.middleware({ params: { cart_id: uuid }, sessionID: 'synthetic-session' }, run.response, run.next);
  assert.equal(run.nextCalls, 0);
  assert.equal(run.response.statusCode, 500);
  assert.deepEqual(run.response.body, { error: { status: 500, message: 'Unable to verify cart access' } });
});
