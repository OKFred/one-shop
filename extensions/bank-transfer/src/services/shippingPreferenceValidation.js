export const SHIPPING_PREFERENCE_MAX_LENGTH = 80;
export const SHIPPING_PREFERENCE_DEFAULT_LABEL = 'SHUSHA recommendation';

// This is an optional customer request, never a carrier booking or rate quote.
export function normalizeShippingPreference(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Preferred courier must be text');
  if (/[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('Preferred courier contains unsupported characters');
  const preference = value.trim();
  if (preference.length > SHIPPING_PREFERENCE_MAX_LENGTH) {
    throw new Error(`Preferred courier must be ${SHIPPING_PREFERENCE_MAX_LENGTH} characters or fewer`);
  }
  return preference || null;
}
