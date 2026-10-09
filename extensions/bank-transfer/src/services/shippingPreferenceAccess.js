const UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function positiveId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sessionId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Use the authenticated customer and the native signed session only. Checkout
// body.customer, ordinary cookies and a cart UUID are not proof of ownership.
export function shippingPreferenceIdentity(request, cookieName) {
  const customer = request.getCurrentCustomer?.();
  return {
    customerId: positiveId(customer?.customer_id),
    sessionIds: [...new Set([
      sessionId(request.sessionID),
      sessionId(request.signedCookies?.[cookieName])
    ].filter(Boolean))]
  };
}

export function canAccessShippingPreferenceCart(cart, identity) {
  if (!cart || cart.status !== true) return false;
  if (cart.customer_id != null) {
    const customerId = positiveId(cart.customer_id);
    return customerId !== null && customerId === identity?.customerId;
  }
  const sid = sessionId(cart.sid);
  return sid !== null && Array.isArray(identity?.sessionIds) && identity.sessionIds.includes(sid);
}

function failure(response, status, message) {
  response.status(status).json({ error: { status, message } });
}

// Kept dependency-injected so the access boundary can be tested without a
// database, native authentication bootstrap or a production connection.
export function createShippingPreferenceAccessMiddleware({ pool, isEnabled, getSessionCookieName }) {
  return async (request, response, next) => {
    let allowed;
    try {
      if (!(await isEnabled())) return next();
      const uuid = request.params?.cart_id;
      if (typeof uuid !== 'string' || !UUID.test(uuid)) {
        return failure(response, 404, 'Cart not found');
      }
      const identity = shippingPreferenceIdentity(request, getSessionCookieName());
      const cart = (await pool.query(
        'SELECT sid,customer_id,status FROM cart WHERE uuid=$1 AND status=TRUE',
        [uuid]
      )).rows[0];
      allowed = canAccessShippingPreferenceCart(cart, identity);
    } catch {
      // Database/config exceptions can contain deployment details. They never
      // become a checkout response, and failed checks never call the handler.
      return failure(response, 500, 'Unable to verify cart access');
    }
    if (!allowed) return failure(response, 404, 'Cart not found');
    return next();
  };
}
