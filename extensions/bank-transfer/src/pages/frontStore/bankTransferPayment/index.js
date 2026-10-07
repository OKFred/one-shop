
import { pool } from '@evershop/evershop/lib/postgres';
import { setContextValue } from '@evershop/evershop/graphql/services';
import { validateOrderUuid } from '../../../services/paymentValidation.js';
export default async (request, response, next) => {
  response.setHeader('Cache-Control', 'private, no-store, max-age=0');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  response.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const uuid = validateOrderUuid(request.params.orderUuid);
    const order = (await pool.query("SELECT order_id FROM \"order\" WHERE uuid=$1 AND payment_method='banktransfer'", [uuid])).rows[0];
    if (!order) response.status(404);
    else setContextValue(request, 'bankTransferGuestUuid', uuid);
    setContextValue(request, 'pageInfo', { title: 'SHUSHA order payment', description: 'Your confirmed order payment information' });
    next();
  } catch (error) {
    if (error.message === 'Invalid order reference') { response.status(404); next(); }
    else next(error);
  }
};
