
import { camelCase } from '@evershop/evershop/lib/util/camelCase';
import { getOrderQuote, customerUrl } from '../../../services/orderPayments.js';
import { orderAccess, authenticatedCustomerId, canonicalOrderUuid } from '../../../services/paymentAccess.js';
import { getConfig } from '@evershop/evershop/lib/util/getConfig';
import { canAccessShippingPreferenceCart, shippingPreferenceIdentity } from '../../../services/shippingPreferenceAccess.js';

async function allowedOrder(context, uuid) {
  let access;
  try { access = orderAccess(context, uuid); } catch { return null; }
  if (!access) return null;
  const args = [canonicalOrderUuid(uuid)];
  let sql = 'SELECT * FROM "order" WHERE uuid=$1';
  if (access.kind === 'customer') { args.push(access.customerId); sql += ' AND customer_id=$2'; }
  return (await context.pool.query(sql, args)).rows[0] || null;
}

function paymentOrder(order) {
  return { orderId: order.order_id, uuid: order.uuid, orderNumber: String(order.order_number), paymentMethod: order.payment_method };
}

export default {
  Query: {
    order: async (_, { uuid }, context) => {
      const order = await allowedOrder(context, uuid);
      return order ? camelCase(order) : null;
    },
    bankTransferPaymentOrder: async (_, __, context) => {
      if (!context.bankTransferGuestUuid) return null;
      const uuid = canonicalOrderUuid(context.bankTransferGuestUuid);
      const order = (await context.pool.query('SELECT order_id,uuid,order_number,payment_method FROM "order" WHERE uuid=$1 AND payment_method=\'banktransfer\'', [uuid])).rows[0];
      return order ? paymentOrder(order) : null;
    },
    bankTransferCustomerPayments: async (_, __, context) => {
      const id = authenticatedCustomerId(context);
      if (!id) return [];
      const orders = (await context.pool.query(`SELECT order_id,uuid,order_number,payment_method FROM "order" WHERE customer_id=$1 AND payment_method='banktransfer' AND payment_status IN ('pending','paid') AND COALESCE(status,'') NOT IN ('canceled','cancelled','closed') ORDER BY order_id DESC LIMIT 50`, [id])).rows;
      return orders.map(paymentOrder);
    },
    bankTransferCustomerPaymentOrder: async (_, { uuid }, context) => {
      if (!authenticatedCustomerId(context)) return null;
      const order = await allowedOrder(context, uuid);
      return order?.payment_method === 'banktransfer' ? paymentOrder(order) : null;
    }
  },
  Cart: {
    // Native cart(id) is UUID-addressable. Free-form customer input must not
    // inherit that access; only myCart's actual session/customer may read it.
    shushaShippingPreference: (cart, _, context) => {
      const identity = shippingPreferenceIdentity({
        signedCookies: context.signedCookies,
        getCurrentCustomer: () => context.customer
      }, getConfig('system.session.cookieName', 'sid'));
      return canAccessShippingPreferenceCart({
        sid: cart.sid, status: cart.status === true || cart.status === 1, customer_id: cart.customerId
      }, identity) ? cart.shushaShippingPreference ?? null : null;
    }
  },
  Order: {
    shushaShippingPreference: async ({ uuid }, _, context) => (await allowedOrder(context, uuid))?.shusha_shipping_preference || null,
    bankTransferQuote: async ({ uuid, orderId }, _, context) => (await allowedOrder(context, uuid)) ? getOrderQuote(orderId, context.pool) : null,
    bankTransferPaymentUrl: async ({ uuid }, _, context) => (await allowedOrder(context, uuid))?.payment_method === 'banktransfer' ? customerUrl(uuid) : null
  },
  BankTransferPaymentOrder: {
    bankTransferQuote: ({ orderId }, _, { pool }) => getOrderQuote(orderId, pool),
    bankTransferPaymentUrl: ({ uuid }) => customerUrl(uuid)
  }
};
