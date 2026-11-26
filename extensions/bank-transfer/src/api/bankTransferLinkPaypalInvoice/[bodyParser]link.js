import { linkPaypalInvoice } from '../../services/orderPayments.js';

export default async (request, response, _next) => {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const data = await linkPaypalInvoice(request.params.orderUuid, request.body || {});
    response.status(200).json({ data });
  } catch {
    const message = 'Invoice was not linked. Refresh the quote and check the PayPal merchant, invoice ID, reference, amount, currency and unpaid status.';
    response.status(400).json({ error: { status: 400, message } });
  }
};
