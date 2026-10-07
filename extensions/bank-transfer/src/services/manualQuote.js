import { countries } from '@evershop/evershop/lib/locale/countries';
import { provinces } from '@evershop/evershop/lib/locale/provinces';
import { isEnabled } from './settings.js';

export const PROVIDER_CODE = 'shusha';
export const CODE = 'manual_quote';
export const NAME = 'Shipping quotation pending';
export const NOTICE = 'Shipping and final payable amount are confirmed by our team before payment.';

export function validateDestination(country, province) {
  if (!countries.some((item) => item.code === country)) throw new Error('Invalid shipping country');
  if (province && !provinces.some((item) => item.countryCode === country && item.code === province)) throw new Error('Invalid shipping province');
}

export function validateQuoteAddress(address) {
  if (!address || typeof address !== 'object') throw new Error('Shipping address is required');
  validateDestination(address.country, address.province);
  for (const name of ['full_name', 'address_1', 'city', 'telephone', 'postcode']) {
    if (typeof address[name] !== 'string' || !address[name].trim()) throw new Error(`Shipping ${name} is required`);
  }
  for (const name of ['address_2', 'province', 'postcode']) {
    if (address[name] != null && typeof address[name] !== 'string') throw new Error(`Invalid shipping ${name}`);
  }
}

export const manualQuoteProvider = {
  code: PROVIDER_CODE,
  name: 'SHUSHA manual shipping quotation',
  description: NOTICE,
  async getMethods(context) {
    if (!(await isEnabled()) || context.currency !== 'USD') return [];
    try { validateDestination(context.destination?.country, context.destination?.province); }
    catch { return []; }
    return [{ code: CODE, name: NAME, cost: 0, metadata: { shippingDeferred: true } }];
  },
  async validateMethod(context, code) {
    if (code !== CODE) return null;
    return (await manualQuoteProvider.getMethods(context))[0] || null;
  }
};

export { countries };
