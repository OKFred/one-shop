export const WHOLESALE_CAMPAIGN = 'wholesale_pilot';
export const WHOLESALE_CHANNELS = Object.freeze([
  { value: 'online-store', label: 'Online store' },
  { value: 'social-selling', label: 'Social media selling' },
  { value: 'shop-or-other', label: 'Shop / other business' }
]);

const clean = value => typeof value === 'string' ? value.trim() : '';
const unsafeText = value => /[\p{Cc}\p{Cf}]/u.test(value.replace(/\r?\n/g, ''));

export function wholesaleContactUrl(value) {
  const url = clean(value);
  return /^https:\/\/wa\.me\/[1-9]\d{6,14}$/.test(url) ? url : '';
}

export function wholesaleCampaign(search = '') {
  const params = new URLSearchParams(search);
  const campaign = { utm_campaign: WHOLESALE_CAMPAIGN };
  for (const key of ['utm_source', 'utm_medium', 'utm_content']) {
    const value = params.get(key);
    if (typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value)) campaign[key] = value;
  }
  return campaign;
}

export function validateWholesaleInquiry(input, countries = []) {
  const country = clean(input?.country);
  const salesChannel = clean(input?.salesChannel);
  const shopUrl = clean(input?.shopUrl);
  const items = clean(input?.items).replace(/\r\n/g, '\n');
  const errors = {};
  const selectedCountry = countries.find(item => item.code === country && typeof item.name === 'string');
  if (!selectedCountry) errors.country = 'Choose the country where you need the goods delivered.';
  const channel = WHOLESALE_CHANNELS.find(item => item.value === salesChannel);
  if (!channel) errors.salesChannel = 'Choose your selling channel.';
  if (!items || items.length > 1200 || unsafeText(items)) errors.items = 'Enter style codes and estimated quantities, using up to 1,200 characters.';
  if (shopUrl) {
    try {
      const parsed = new URL(shopUrl);
      if (shopUrl.length > 500 || /[\p{Cc}\p{Cf}]/u.test(shopUrl) || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid shop URL');
    } catch { errors.shopUrl = 'Enter a complete http:// or https:// shop/profile link, or leave it blank.'; }
  }
  return { errors, value: { country, countryName: selectedCountry?.name || '', salesChannel, salesChannelName: channel?.label || '', shopUrl, items } };
}

export function buildWholesaleDraft(input, { countries = [], contactUrl = '', campaign = {} } = {}) {
  const contact = wholesaleContactUrl(contactUrl);
  if (!contact) return { errors: { form: 'Please contact SHUSHA to request a quotation.' } };
  const { errors, value } = validateWholesaleInquiry(input, countries);
  if (Object.keys(errors).length) return { errors };
  const attribution = wholesaleCampaign(new URLSearchParams(campaign).toString());
  const lines = [
    'Hello SHUSHA, I would like a wholesale quote.',
    '',
    `Destination country: ${value.countryName} (${value.country})`,
    `Selling channel: ${value.salesChannelName}`,
    ...(value.shopUrl ? [`Shop / profile: ${value.shopUrl}`] : []),
    '',
    'Styles / SKUs and estimated quantities:',
    value.items,
    '',
    'Please confirm minimum quantities, supply prices, availability and shipping for this enquiry.',
    '',
    `Campaign: ${WHOLESALE_CAMPAIGN}`,
    ...['utm_source', 'utm_medium', 'utm_content'].filter(key => attribution[key]).map(key => `${key}: ${attribution[key]}`)
  ];
  const message = lines.join('\n');
  const href = `${contact}?text=${encodeURIComponent(message)}`;
  if (href.length > 8000) return { errors: { items: 'Please shorten the style list and send any extra details in WhatsApp.' } };
  return { errors: {}, message, href };
}
