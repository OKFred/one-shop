
import { camelCase } from '@evershop/evershop/lib/util/camelCase';
import { getOrderQuote, customerUrl } from '../../../services/orderPayments.js';
import { buildUrl } from '@evershop/evershop/lib/router';
import { paypalInvoicesEnabled } from '../../../services/paypalInvoices.js';
import { orderAccess, authenticatedCustomerId, canonicalOrderUuid, canOpenPaypalInvoice, paypalBuyerAccess } from '../../../services/paymentAccess.js';
import { getConfig } from '@evershop/evershop/lib/util/getConfig';
import { canAccessShippingPreferenceCart, shippingPreferenceIdentity } from '../../../services/shippingPreferenceAccess.js';

const paymentOrders = `SELECT order_id, uuid, order_number, payment_method, payment_status, customer_id, sid
  FROM "order"
  WHERE payment_method='banktransfer' AND payment_status IN ('pending','paid')
    AND COALESCE(status,'') NOT IN ('canceled','cancelled','closed')
    AND COALESCE(shipment_status,'') NOT IN ('canceled','cancelled')`;

async function allowedOrder(context, uuid) {
  let access;
  try { access = orderAccess(context, uuid); } catch { return null; }
  if (!access) return null;
  const args = [canonicalOrderUuid(uuid)];
  let sql = 'SELECT * FROM "order" WHERE uuid=$1';
  if (access.kind === 'customer') { args.push(access.customerId); sql += ' AND customer_id=$2'; }
  return (await context.pool.query(sql, args)).rows[0] || null;
}

function paymentOrder(order, context) {
  const sid = context.sid ?? context.signedCookies?.[getConfig('system.session.cookieName', 'sid')];
  return {
    orderId: order.order_id,
    uuid: order.uuid,
    orderNumber: String(order.order_number),
    paymentMethod: order.payment_method,
    paymentStatusCode: order.payment_status,
    buyerCanOpenPaypal: canOpenPaypalInvoice(order, paypalBuyerAccess(context.customer, sid))
  };
}

async function paymentQuote(order, pool) {
  const quote = await getOrderQuote(order.orderId, pool);
  if (quote?.status === 'confirmed' && quote.paypalInvoiceLinked && quote.paypalInvoiceEnvironmentMatches && order.buyerCanOpenPaypal && paypalInvoicesEnabled()) {
    return { ...quote, paypalPaymentUrl: buildUrl('bankTransferPaypalInvoice', { orderUuid: order.uuid, quoteRevision: String(quote.revision) }) };
  }
  return quote;
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
      const order = (await context.pool.query(`${paymentOrders} AND uuid=$1`, [uuid])).rows[0];
      return order ? paymentOrder(order, context) : null;
    },
    bankTransferCustomerPayments: async (_, __, context) => {
      const id = authenticatedCustomerId(context);
      if (!id) return [];
      const orders = (await context.pool.query(`${paymentOrders} AND customer_id=$1 ORDER BY order_id DESC LIMIT 50`, [id])).rows;
      return orders.map((order) => paymentOrder(order, context));
    },
    bankTransferCustomerPaymentOrder: async (_, { uuid }, context) => {
      const customerId = authenticatedCustomerId(context);
      if (!customerId) return null;
      let orderUuid;
      try { orderUuid = canonicalOrderUuid(uuid); } catch { return null; }
      const order = (await context.pool.query(`${paymentOrders} AND uuid=$1 AND customer_id=$2`, [orderUuid, customerId])).rows[0];
      return order ? paymentOrder(order, context) : null;
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
    bankTransferQuote: async ({ uuid }, _, context) => {
      const order = await allowedOrder(context, uuid);
      return order ? paymentQuote(paymentOrder(order, context), context.pool) : null;
    },
    bankTransferPaymentUrl: async ({ uuid }, _, context) => (await allowedOrder(context, uuid))?.payment_method === 'banktransfer' ? customerUrl(uuid) : null
  },
  BankTransferPaymentOrder: {
    bankTransferQuote: (order, _, { pool }) => paymentQuote(order, pool),
    bankTransferPaymentUrl: ({ uuid }) => customerUrl(uuid)
  }
};
