import { validateOrderUuid } from './paymentValidation.js';

export function authenticatedCustomerId(context) {
  const id = Number(context.customer?.customer_id ?? context.customer?.customerId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function paypalBuyerAccess(customer, sid) {
  if (!customer) return { kind: 'guest' };
  return { kind: 'customer', customerId: authenticatedCustomerId({ customer }), sid };
}

export function canOpenPaypalInvoice(order, access) {
  if (!order || !access || !Object.hasOwn(order, 'customer_id')) return false;
  if (access.kind === 'guest') return order.customer_id === null;
  if (access.kind !== 'customer' || !Number.isSafeInteger(access.customerId) || access.customerId < 1) return false;
  if (order.customer_id !== null) return Number(order.customer_id) === access.customerId;
  // A guest can sign in after placing the order in this checkout session.
  return typeof access.sid === 'string' && access.sid.length > 0 && access.sid === order.sid;
}

export function canonicalOrderUuid(uuid) {
  validateOrderUuid(uuid);
  const compact = uuid.replaceAll('-', '').toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function sameOrderUuid(a, b) {
  try { return canonicalOrderUuid(a) === canonicalOrderUuid(b); } catch { return false; }
}

export function orderAccess(context, uuid) {
  validateOrderUuid(uuid);
  if (context.user) return { kind: 'admin' };
  // Native checkout-success verifies the exact order and its browser session,
  // including a guest order followed by login in that same session.
  if (sameOrderUuid(context.orderId, uuid)) return { kind: 'checkout' };
  const customerId = authenticatedCustomerId(context);
  if (customerId) return { kind: 'customer', customerId };
  return null;
}
