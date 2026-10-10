// Compile merchant extensions before running. Uses synthetic public fields only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSchema, parse, validate } from 'graphql';
import { scanRouteComponents } from '../packages/evershop/dist/lib/componee/scanForComponents.js';
import { parseGraphqlByFile } from '../packages/evershop/dist/lib/webpack/util/parseGraphqlByFile.js';

// Native webpack's public component alias, plus style handling for Node SSR.
// The actual Area, app provider, footer and route components are not mocked.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@components/')) return { url: pathToFileURL(path.resolve('packages/evershop/dist/components', specifier.slice('@components/'.length))).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (/\.(?:scss|css)$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  }
});

const { default: Card, merchantAddressLines } = await import('../extensions/storefront-brand/dist/components/MerchantContactCard.js');
const { default: MerchantFooter, query: footerQuery, layout: footerLayout } = await import('../extensions/storefront-brand/dist/pages/frontStore/all/MerchantFooter.js');
const { default: PageDetails, query: pageQuery } = await import('../extensions/storefront-brand/dist/pages/frontStore/cmsPageView/MerchantPageDetails.js');
const { Footer } = await import('../extensions/storefront-brand/dist/components/frontStore/Footer.js');
const { setAreaComponents } = await import('../packages/evershop/dist/components/common/Area.js');
const { AppProvider } = await import('../packages/evershop/dist/components/common/context/app.js');
const render = (Component, props = {}) => renderToStaticMarkup(React.createElement(Component, props));
const profile = {
  shopName: 'SHUSHA', legalName: '',
  address: { line1: '10 Sample & Example Road', line2: 'Suite 2', city: 'Example City', postalCode: '00000', country: 'Example Country' },
  support: { email: 'support+shop@example.invalid', whatsappSriLanka: 'https://wa.me/15555550101', whatsappChina: 'https://wa.me/15555550102' }
};

test('actual contact card renders escaped public fields, safe outbound links and offline SVGs', () => {
  const html = render(Card, { publicMerchantProfile: profile });
  assert.match(html, /10 Sample &amp; Example Road/);
  assert.match(html, /Example City 00000/);
  assert.match(html, /href="mailto:support%2Bshop%40example.invalid"/);
  assert.match(html, /href="https:\/\/wa\.me\/15555550101"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /https:\/\/www.google.com\/maps\/search\/\?api=1&amp;query=10%20Sample%20%26%20Example%20Road/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /<script|<iframe|<img|api\.iconify|Registered office|Headquarters|Opening hours/i);
  assert.deepEqual(merchantAddressLines(profile), ['10 Sample & Example Road', 'Suite 2', 'Example City 00000', 'Example Country']);
});

test('missing public profile exposes no invented contact/company details or empty blocks', () => {
  assert.equal(render(Card), '');
  assert.equal(render(Card, { publicMerchantProfile: { shopName: 'SHUSHA', address: {}, support: {} } }), '');
  const footer = render(MerchantFooter);
  assert.match(footer, />SHUSHA<\/a>/);
  assert.match(footer, /href="\/contact"/);
  assert.doesNotMatch(footer, /mailto:|wa\.me|Contact address|Merchant contact details/);
});

test('unsafe contact protocols and undeclared private fields never become storefront links or text', () => {
  const unsafe = { shopName: 'SHUSHA', legalName: '<script>synthetic</script>', address: {}, support: { email: 'support@example.invalid?bcc=other@example.invalid', whatsappSriLanka: 'javascript:alert(1)', whatsappChina: 'https://wa.me.example.invalid/15555550101' }, bankDetails: 'synthetic-private-account', apiToken: 'synthetic-private-token' };
  const html = render(Card, { publicMerchantProfile: unsafe });
  assert.match(html, /&lt;script&gt;synthetic&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|href=|synthetic-private|javascript:|bcc=/);
});

test('native Area resolves the footer page query and keeps editable upstream footer areas', () => {
  const componentId = 'merchant-footer-synthetic';
  const parsed = parseGraphqlByFile(path.resolve('extensions/storefront-brand/dist/pages/frontStore/all/MerchantFooter.js'));
  assert.equal(parsed.query.props.length, 1);
  assert.equal(parsed.query.props[0].origin, 'publicMerchantProfile');
  setAreaComponents('merchant-test', { [footerLayout.areaId]: { [componentId]: { id: componentId, sortOrder: footerLayout.sortOrder, component: { default: MerchantFooter } } } });
  const context = { config: { pageMeta: { route: { id: 'merchant-test' } } }, widgets: [], propsMap: { [componentId]: parsed.query.props }, graphqlResponse: { [parsed.query.props[0].alias]: profile } };
  const html = renderToStaticMarkup(React.createElement(AppProvider, { value: context }, React.createElement(Footer, { copyRight: 'Synthetic copyright' })));
  assert.equal((html.match(/shusha-footer-wordmark/g) || []).length, 1);
  assert.equal((html.match(/href="https:\/\/wa\.me\/15555550101"/g) || []).length, 1);
  assert.match(html, /data-evershop-area-id="footerTop"/);
  for (const area of ['footerMiddleLeft', 'footerMiddleCenter', 'footerMiddleRight']) assert.match(html, new RegExp(`data-evershop-area-id="${area}"`));
  assert.match(html, /Synthetic copyright/);
});

test('native route discovery preserves CMS renderer and company details only mark about/contact', () => {
  const modules = [
    { name: 'cms', path: path.resolve('packages/evershop/dist/modules/cms') },
    { name: 'storefront-brand', path: path.resolve('extensions/storefront-brand/dist') }
  ];
  const cms = scanRouteComponents({ id: 'cmsPageView', isAdmin: false }, modules);
  assert.equal(cms['cmsPageView/CmsPageView.js'], path.resolve('packages/evershop/dist/modules/cms/pages/frontStore/cmsPageView/CmsPageView.js'));
  assert.equal(cms['cmsPageView/MerchantPageDetails.js'], path.resolve('extensions/storefront-brand/dist/pages/frontStore/cmsPageView/MerchantPageDetails.js'));
  const home = scanRouteComponents({ id: 'homepage', isAdmin: false }, modules);
  assert.equal(home['cmsPageView/MerchantPageDetails.js'], undefined);
  for (const urlKey of ['shipping-payment', 'privacy-policy', 'how-to-order', 'about-other', '', undefined]) assert.equal(render(PageDetails, { merchantPage: { urlKey }, publicMerchantProfile: profile }), '');
  for (const urlKey of ['about', 'contact']) {
    const html = render(PageDetails, { merchantPage: { urlKey }, publicMerchantProfile: profile });
    assert.match(html, /class="shusha-company-page"/);
    assert.match(html, /Contact address/);
    assert.match(html, /confirmed personally before you pay/);
  }
});

test('both scanned queries validate against the actual public field schema without exposing private fields', async () => {
  const publicSchema = await readFile('extensions/storefront-brand/src/graphql/types/PublicMerchantProfile/PublicMerchantProfile.graphql', 'utf8');
  const schema = buildSchema(`type CmsPage { urlKey: String } type Query { currentCmsPage: CmsPage } ${publicSchema}`);
  for (const query of [footerQuery, pageQuery]) assert.deepEqual(validate(schema, parse(query)), []);
  const parsed = parseGraphqlByFile(path.resolve('extensions/storefront-brand/dist/pages/frontStore/cmsPageView/MerchantPageDetails.js'));
  assert.deepEqual(parsed.query.props.map(item => item.origin), ['merchantPage', 'publicMerchantProfile']);
  assert.doesNotMatch(`${footerQuery}${pageQuery}`, /bank|receipt|order|customer|token/i);
});
