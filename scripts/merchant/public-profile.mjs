export { validatePublicMerchantProfile, loadPublicMerchantProfile, publicAddressLines, publicMapUrl, shopifyPublicProfileSettings } from '../../extensions/storefront-brand/src/services/publicProfile.js';
import { validatePublicMerchantProfile } from '../../extensions/storefront-brand/src/services/publicProfile.js';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// These pages contain public shop copy only. Order-specific payment information
// is deliberately kept in the existing authenticated payment flow.
export function buildPublicCompanyPages(input) {
  const profile = validatePublicMerchantProfile(input);
  const brand = escape(profile.shopName);
  const operator = profile.legalName ? `<p>Business name: <strong>${escape(profile.legalName)}</strong>.</p>` : '';
  return [
    { handle: 'about', title: `About ${profile.shopName}`, templateSuffix: 'about',
      bodyHtml: `<h2>Clothing from Sri Lanka, with personal support</h2><p>${brand} serves customers around the world with clothing shipped from Sri Lanka.</p>${operator}<h2>A clear path from request to delivery</h2><p>Choose your preferred style, size and colour, then submit your order request. We manually confirm availability, shipping costs and payment instructions before you pay.</p><p>Once your quote is confirmed, you can open the payment instructions from your order. Wise and bank transfer details are provided for that confirmed order.</p><h2>Talk to us before ordering</h2><p>Our team can help with product questions and your delivery preferences. For order enquiries, include your order number in your message.</p>` },
    { handle: 'contact', title: 'Contact us', templateSuffix: 'contact',
      bodyHtml: `<h2>Let’s find the right pieces for you</h2><p>Contact ${brand} for questions about styles, sizes, colours or an existing order request.</p>${operator}<h2>For an existing order</h2><p>Please include your order number so we can locate your request. Availability, shipping costs and payment instructions are confirmed manually before payment.</p><h2>Our location</h2><p>Our public contact address and available support channels are listed below. Please contact us before arranging a visit or sending a parcel.</p>` }
  ];
}
