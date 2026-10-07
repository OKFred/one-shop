import { confirmQuote } from '../../services/orderPayments.js';
export default async (request, response, next) => {
  try {
    const data = await confirmQuote(request.params.orderUuid, request.body || {});
    response.status(200).json({ data });
  } catch (error) {
    // Do not return DB/config exceptions containing private receiving details.
    const message = error.code || error instanceof SyntaxError || /ENOENT|configuration|Invalid Wise open link|official Wise/.test(error.message) ? 'Payment receiving configuration is unavailable; contact the administrator' : error.message;
    response.status(400).json({ error: { status: 400, message } });
  }
};
