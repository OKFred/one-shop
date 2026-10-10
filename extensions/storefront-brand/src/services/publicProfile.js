import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const object = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Public company profile contains unsupported fields');
}
function text(value = '', maximum = 200) {
  if (typeof value !== 'string' || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('Invalid public company text');
  return value.trim();
}

// Only explicitly public merchant fields may cross the storefront boundary.
// Receiving details, credentials and registration documents have no fields here.
export function validatePublicMerchantProfile(input) {
  keys(input, ['schemaVersion', 'shopName', 'legalName', 'address', 'support']);
  if (input.schemaVersion !== 1) throw new Error('Unsupported public company profile version');
  const address = input.address || {}; const support = input.support || {};
  keys(address, ['line1', 'line2', 'city', 'postalCode', 'country', 'countryCode']);
  keys(support, ['email', 'whatsappSriLanka', 'whatsappChina']);
  const result = { schemaVersion: 1, shopName: text(input.shopName, 100), legalName: text(input.legalName), address: {}, support: {} };
  if (!result.shopName) throw new Error('Public shop name is required');
  for (const field of ['line1', 'line2', 'city', 'postalCode', 'country', 'countryCode']) result.address[field] = text(address[field], field === 'postalCode' ? 30 : 200);
  if (result.address.countryCode && !/^[A-Z]{2}$/.test(result.address.countryCode)) throw new Error('Invalid public country code');
  if (result.address.line1 && (!result.address.city || !result.address.country || !result.address.countryCode)) throw new Error('Public address needs a city and country');
  const email = text(support.email, 254);
  if (email && !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(email)) throw new Error('Invalid public support email');
  result.support.email = email;
  for (const field of ['whatsappSriLanka', 'whatsappChina']) {
    const value = text(support[field], 80);
    if (value && !/^https:\/\/wa\.me\/[1-9]\d{6,14}$/.test(value)) throw new Error('Invalid public WhatsApp link');
    result.support[field] = value;
  }
  return result;
}

export const EMPTY_PUBLIC_PROFILE = Object.freeze({ schemaVersion: 1, shopName: 'SHUSHA', legalName: '', address: Object.freeze({}), support: Object.freeze({}) });

export async function loadPublicMerchantProfile({ env = process.env, cwd = process.cwd() } = {}) {
  const explicit = Boolean(env.SHUSHA_PUBLIC_PROFILE_FILE);
  const filename = path.resolve(cwd, env.SHUSHA_PUBLIC_PROFILE_FILE || 'private/public-company-profile.json');
  try {
    const resolved = await realpath(filename);
    if (!resolved.split(path.sep).some(part => ['private', 'private-data'].includes(part))) throw new Error('Invalid profile location');
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768) throw new Error('Invalid profile file');
    return validatePublicMerchantProfile(JSON.parse(await readFile(filename, 'utf8')));
  } catch (error) {
    if (!explicit && error.code === 'ENOENT') return validatePublicMerchantProfile(EMPTY_PUBLIC_PROFILE);
    throw new Error('Public company profile is unavailable or invalid');
  }
}

export function publicAddressLines(input) {
  const { address } = validatePublicMerchantProfile(input);
  if (!address.line1) return [];
  return [address.line1, address.line2, [address.city, address.postalCode].filter(Boolean).join(' '), address.country].filter(Boolean);
}

export function publicMapUrl(input) {
  const lines = publicAddressLines(input);
  return lines.length ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lines.join(', '))}` : '';
}

export function shopifyPublicProfileSettings(input) {
  const profile = validatePublicMerchantProfile(input);
  return { shusha_business_name: profile.legalName,
    shusha_business_address_line1: profile.address.line1, shusha_business_address_line2: profile.address.line2,
    shusha_business_city: profile.address.city, shusha_business_postal_code: profile.address.postalCode,
    shusha_business_country: profile.address.country, shusha_support_email: profile.support.email,
    shusha_whatsapp_sri_lanka: profile.support.whatsappSriLanka, shusha_whatsapp_china: profile.support.whatsappChina };
}
