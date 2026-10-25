// Compile merchant extensions first. Tests use synthetic contact and shop data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSchema, parse, validate } from 'graphql';
import { scanRouteComponents } from '../packages/evershop/dist/lib/componee/scanForComponents.js';
import { parseGraphqlByFile } from '../packages/evershop/dist/lib/webpack/util/parseGraphqlByFile.js';
import { buildWholesaleDraft, validateWholesaleInquiry, wholesaleCampaign } from '../extensions/storefront-brand/src/services/wholesaleInquiry.js';

registerHooks({
  load(url, context, nextLoad) {
    if (/\.(?:scss|css)$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  }
});
const { default: Wholesale, query } = await import('../extensions/storefront-brand/dist/pages/frontStore/wholesale/Wholesale.js');
const countries = [{ code: 'GB', name: 'United Kingdom' }, { code: 'LK', name: 'Sri Lanka' }];
const input = { country: 'GB', salesChannel: 'social-selling', items: 'L1001, blue & cream, M — 8 pieces\nL1002 XL — 4 pieces', shopUrl: 'https://example.invalid/shop?colour=blue&size=M' };
const contactUrl = 'https://wa.me/15555550101';
const profile = { shopName: 'SHUSHA', address: { line1: '10 Sample Road', city: 'Example City', postalCode: '00000', country: 'Example Country' }, support: { whatsappSriLanka: contactUrl } };

test('a valid enquiry is a correctly encoded WhatsApp draft with exact details and no order/payment action', () => {
  const draft = buildWholesaleDraft(input, { countries, contactUrl, campaign: { utm_source: 'tiktok', utm_medium: 'organic', utm_campaign: 'ignored', utm_content: 'creative-001' } });
  assert.deepEqual(draft.errors, {});
  const url = new URL(draft.href);
  assert.equal(url.origin, 'https://wa.me');
  assert.equal(url.pathname, '/15555550101');
  assert.deepEqual([...url.searchParams.keys()], ['text']);
  assert.equal(url.searchParams.get('text'), draft.message);
  assert.match(draft.message, /Destination country: United Kingdom \(GB\)/);
  assert.match(draft.message, /Selling channel: Social media selling/);
  assert(draft.message.includes(input.items));
  assert(draft.message.includes(input.shopUrl));
  assert.match(draft.message, /Campaign: wholesale_pilot\nutm_source: tiktok\nutm_medium: organic\nutm_content: creative-001/);
  assert.doesNotMatch(draft.href, /checkout|payment|api\/|mailto:/);
});

test('required country, selling channel and product/quantity text are checked against actual options', () => {
  assert.deepEqual(Object.keys(validateWholesaleInquiry({}, countries).errors).sort(), ['country', 'items', 'salesChannel']);
  assert(validateWholesaleInquiry({ ...input, country: 'XX' }, countries).errors.country);
  assert(validateWholesaleInquiry({ ...input, salesChannel: 'invented-channel' }, countries).errors.salesChannel);
  assert(validateWholesaleInquiry({ ...input, items: ' ' }, countries).errors.items);
  assert(validateWholesaleInquiry({ ...input, items: 'x'.repeat(1201) }, countries).errors.items);
  assert(validateWholesaleInquiry({ ...input, items: 'L1001\u0000secret' }, countries).errors.items);
  assert.equal(buildWholesaleDraft(input, { countries: [], contactUrl }).href, undefined);
});

test('shop/profile is optional; unsafe URLs and receiving targets cannot become links', () => {
  const withoutShop = buildWholesaleDraft({ ...input, shopUrl: '' }, { countries, contactUrl });
  assert.deepEqual(withoutShop.errors, {});
  assert.doesNotMatch(withoutShop.message, /Shop \/ profile:/);
  for (const shopUrl of ['javascript:alert(1)', 'https://user:password@example.invalid/', 'https://example.invalid/\nextra', 'not-a-url']) {
    assert.equal(buildWholesaleDraft({ ...input, shopUrl }, { countries, contactUrl }).href, undefined);
  }
  for (const target of ['', 'javascript:alert(1)', `${contactUrl}?redirect=other`, 'https://wa.me.example.invalid/15555550101', 'https://wa.me/15555550101/']) {
    assert.equal(buildWholesaleDraft(input, { countries, contactUrl: target }).href, undefined);
  }
});

test('campaign attribution only forwards bounded public identifiers, never arbitrary query values', () => {
  const campaign = wholesaleCampaign('?utm_source=tiktok&utm_medium=organic&utm_campaign=other&utm_content=creative_001&email=private%40example.invalid&country=GB&items=private');
  assert.deepEqual(campaign, { utm_campaign: 'wholesale_pilot', utm_source: 'tiktok', utm_medium: 'organic', utm_content: 'creative_001' });
  assert.deepEqual(wholesaleCampaign('?utm_source=private%40example.invalid&utm_medium=x%0Avalue&utm_content=' + 'x'.repeat(65)), { utm_campaign: 'wholesale_pilot' });
  const draft = buildWholesaleDraft(input, { countries, contactUrl, campaign });
  assert.doesNotMatch(draft.message, /private@example|utm_campaign: other|email:/);
});

test('standalone GET route and native scanner expose the page without CMS creation or core replacement', async () => {
  const route = JSON.parse(await readFile('extensions/storefront-brand/src/pages/frontStore/wholesale/route.json', 'utf8'));
  assert.equal(route.path, '/wholesale');
  assert.deepEqual(route.methods, ['GET']);
  const modules = [{ name: 'storefront-brand', path: path.resolve('extensions/storefront-brand/dist') }];
  const own = scanRouteComponents({ id: 'wholesale', isAdmin: false }, modules);
  assert.equal(own['wholesale/Wholesale.js'], path.resolve('extensions/storefront-brand/dist/pages/frontStore/wholesale/Wholesale.js'));
  assert.equal(scanRouteComponents({ id: 'homepage', isAdmin: false }, modules)['wholesale/Wholesale.js'], undefined);
  const parsed = parseGraphqlByFile(path.resolve('extensions/storefront-brand/dist/pages/frontStore/wholesale/Wholesale.js'));
  assert.deepEqual(parsed.query.props.map(item => item.origin), ['countries', 'publicMerchantProfile']);
  const profileSchema = await readFile('extensions/storefront-brand/src/graphql/types/PublicMerchantProfile/PublicMerchantProfile.graphql', 'utf8');
  const schema = buildSchema(`type Country { code: String! name: String! } type Query { countries: [Country] } ${profileSchema}`);
  assert.deepEqual(validate(schema, parse(query)), []);
  assert.doesNotMatch(query, /order|customer|bank|receipt|token/i);
});

test('SSR is accessible and keeps inputs disabled until client handlers are ready', () => {
  const html = renderToStaticMarkup(React.createElement(Wholesale, { countries, publicMerchantProfile: profile }));
  assert.match(html, /<h1 id="shusha-wholesale-title">/);
  assert.match(html, /Request a wholesale quote/);
  const formTag = html.match(/<form\b[^>]*>/)?.[0] || '';
  assert.match(formTag, /method="post"/);
  assert.match(formTag, /action="\/wholesale"/);
  assert.match(html, /<fieldset disabled="">/);
  assert.match(html, /type="submit" disabled=""/);
  for (const id of ['wholesale-country', 'wholesale-sales-channel', 'wholesale-items', 'wholesale-shop-url']) assert.match(html, new RegExp(`for="${id}"`));
  assert.match(html, /press Send in WhatsApp/);
  assert.match(html, /retail reference prices/);
  assert.match(html, /href="\/dresses"/);
  assert.match(html, /href="\/tops"/);
  assert.match(html, /href="\/pants"/);
  assert.doesNotMatch(html, /<script|<iframe|<img|minimum order is|guaranteed profit|exclusive distribution/i);
  const unavailable = renderToStaticMarkup(React.createElement(Wholesale, { countries }));
  assert.match(unavailable, /Quote requests are temporarily unavailable/);
  assert.doesNotMatch(unavailable, /wa\.me/);
});
