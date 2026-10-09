import { pool } from '@evershop/evershop/lib/postgres';
import { normalizeShippingPreference } from './shippingPreferenceValidation.js';

export const shippingPreferenceField = {
  key: 'shusha_shipping_preference',
  resolvers: [(value) => value ?? null]
};

export async function saveCheckoutShippingPreference(cartUuid, data) {
  // Old clients may omit the field. Keep their existing cart preference.
  if (data.shushaShippingPreference === undefined) return;
  const preference = normalizeShippingPreference(data.shushaShippingPreference);
  // Update only this extension's field. A second full saveCart would rewrite
  // item quantities/prices and unnecessarily widen the native checkout race.
  const result = await pool.query(
    'UPDATE cart SET shusha_shipping_preference=$1 WHERE uuid=$2 AND status=TRUE RETURNING cart_id',
    [preference, cartUuid]
  );
  if (result.rowCount !== 1) throw new Error('Cart not found');
  // Native checkout reloads the cart and copies exportData into the order in
  // its own transaction. Failed placement keeps the preference for retry.
}
