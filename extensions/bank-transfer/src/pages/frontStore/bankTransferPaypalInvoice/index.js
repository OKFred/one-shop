import { canonicalOrderUuid, paypalBuyerAccess } from '../../../services/paymentAccess.js';
import { openPaypalInvoice } from '../../../services/orderPayments.js';

// EverShop treats a two-argument handler as a delegate and continues rendering.
export default async function openInvoice(request, response, _next) {
  const unavailable = () => response.status(404).type('text/plain')
    .send('This PayPal payment link is unavailable. Return to your order for current payment instructions.');
  const { orderUuid, quoteRevision } = request.params;
  if (!/^[1-9]\d{0,9}$/.test(quoteRevision)) return unavailable();
  try {
    const customer = request.getCurrentCustomer();
    if (request.isCustomerLoggedIn() && !customer) return unavailable();
    const access = paypalBuyerAccess(customer, request.sessionID);
    const url = await openPaypalInvoice(canonicalOrderUuid(orderUuid), Number(quoteRevision), access);
    return response.redirect(302, url);
  } catch {
    return unavailable();
  }
}
