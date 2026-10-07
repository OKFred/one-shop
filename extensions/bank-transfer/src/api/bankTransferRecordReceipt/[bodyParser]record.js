import { recordReceipt } from '../../services/orderPayments.js';
export default async (request, response, next) => {
  try {
    const data = await recordReceipt(request.params.orderUuid, request.body || {});
    response.status(200).json({ data });
  } catch (error) {
    const message = error.code ? 'Payment registration could not be completed; no changes were saved' : error.message;
    response.status(400).json({ error: { status: 400, message } });
  }
};
