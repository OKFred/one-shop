import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOptions, pageContext, hasOfflineIcons, hasCmsContent, verifyHttp } from '../../deployment/candidate-http.mjs';

const fixtureUuid = '00000000-0000-4000-8000-000000000001';
const icons = ['M6.488 7.469', 'M17.472 14.382'].map(d => `<svg aria-hidden="true" focusable="false"><path d="${d}"/></svg>`).join('');
const page = (markup, graphqlResponse = {}) => `<html><head><script>var eContext = ${JSON.stringify({ graphqlResponse })}</script></head><body>${markup}<script src="/fixture.js"></script></body></html>`;
const cmsPaths = ['/how-to-order', '/shipping-payment', '/contact'];
const cmsMarkup = '<div class="cms-page"><h1 class="cms__page__heading">Fixture CMS</h1><div class="editor__html"><div class="row__container"><div class="column__container"><p>Original synthetic content</p></div></div></div></div>';
const cmsPage = () => page(cmsMarkup, { page: { name: 'Fixture CMS', content: [{ size: 1, columns: [{ size: 1, data: { blocks: [{ type: 'raw', data: { html: '<p>Original synthetic content</p>' } }] } }] }] } });
const schema = {
  guest: { fields: ['orderNumber', 'paymentMethod', 'bankTransferQuote', 'bankTransferPaymentUrl'].map(name => ({ name })) },
  setting: { fields: [{ name: 'bankTransferPaymentStatus' }] },
  __schema: { queryType: { fields: [{ name: 'order' }] } },
  bankTransferPaymentOrder: null, bankTransferCustomerPayments: []
};

test('HTTP acceptance restricts origin, path and private quote options', () => {
  assert.equal(parseOptions([], {}).origin, 'http://127.0.0.1:5444');
  for (const origin of ['https://shop.example.invalid', 'http://localhost:5444', 'http://127.0.0.1/private', 'http://user:secret@127.0.0.1:5444']) {
    assert.throws(() => parseOptions(['--origin', origin], {}), /candidate-origin-must-be-loopback/);
  }
  assert.throws(() => parseOptions(['--require-payment'], {}), /test-order-uuid-required/);
  assert.throws(() => parseOptions([], { SHUSHA_TEST_PRODUCTS: '["/api/order"]' }), /invalid-product-path/);
  assert.throws(() => parseOptions([], { SHUSHA_TEST_QUOTE_AMOUNT: '1e4' }), /invalid-quote-amount/);
});

test('SSR context parser treats script as JSON and icons require local SVG paths', () => {
  assert.deepEqual(pageContext(page('fixture', { safe: true })).graphqlResponse, { safe: true });
  assert.throws(() => pageContext('<script>var eContext = process.exit()</script>'), /ssr-context-invalid/);
  assert.equal(hasOfflineIcons(icons), true);
  assert.equal(hasOfflineIcons('<script>' + icons + '</script>'), false);
  assert.equal(hasOfflineIcons(icons.replaceAll('aria-hidden="true"', '')), false);
  assert.equal(hasCmsContent(cmsPage()), true);
  assert.equal(hasCmsContent(page(cmsMarkup)), false);
  assert.equal(hasCmsContent(cmsPage().replace('editor__html', 'empty-editor')), false);
});

test('candidate fixture validates payment privacy and never issues a mutation or provider request', async () => {
  const calls = [];
  const quote = { status: 'confirmed', currency: 'GBP', amount: '1.99', wisePaymentUrl: 'https://wise.com/pay/business/synthetic-only', bankDetails: [{ label: 'Synthetic', value: 'WITHHELD' }] };
  const fakeFetch = async (url, init) => {
    calls.push({ path: url.pathname, method: init.method || 'GET' });
    assert.equal(url.origin, 'http://127.0.0.1:5444');
    assert.equal(init.redirect, 'manual');
    if (init.method === 'POST') {
      assert.equal(url.pathname, '/api/graphql');
      const body = JSON.parse(init.body);
      assert.equal(/\bmutation\b/.test(body.query), false);
      const data = body.query.includes('__schema') ? schema : { order: null, bankTransferCustomerPaymentOrder: null };
      return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
    }
    if (url.pathname === '/assets/shusha/shusha-wordmark.svg') return new Response('<svg><text>SHUSHA</text></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
    if (url.pathname === '/legacy-dress') return new Response('', { status: 301, headers: { Location: '/dresses/l1001' + url.search } });
    if (cmsPaths.includes(url.pathname)) return new Response(cmsPage(), { headers: { 'Content-Type': 'text/html' } });
    if (cmsPaths.includes(url.pathname.replace(/^\/page/, ''))) return new Response('', { status: 301, headers: { Location: url.pathname.slice(5) + url.search } });
    if (url.pathname === '/fixture.js') return new Response('fixture', { headers: { 'Content-Type': 'text/javascript' } });
    if (url.pathname.startsWith('/payment/')) {
      const html = page(`<h1>Payment</h1>${icons}<a href="${quote.wisePaymentUrl}" rel="noopener noreferrer">Pay with Wise</a>`, { order: { orderNumber: 'TEST-ONLY', paymentMethod: 'banktransfer', bankTransferQuote: quote } });
      return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });
    }
    const html = url.pathname === '/' ? page(`<strong>SHUSHA</strong><section class="shusha-hero"><h1>Fixture</h1></section><a href="/dresses">Dresses</a><a href="/pants">Pants</a><a href="/tops">Tops</a><img src="/assets/shusha/shusha-wordmark.svg"/>${icons}WhatsApp Wise`) : page('<h1>Fixture catalog</h1>', { product: { uuid: fixtureUuid } });
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  };
  const options = parseOptions(['--require-payment'], { SHUSHA_TEST_ORDER_UUID: fixtureUuid, SHUSHA_TEST_QUOTE_STATUS: 'confirmed', SHUSHA_TEST_QUOTE_CURRENCY: 'GBP', SHUSHA_TEST_QUOTE_AMOUNT: '1.99', SHUSHA_TEST_PRODUCTS: JSON.stringify([{ path: '/dresses/l1001', uuid: fixtureUuid }]), SHUSHA_TEST_LEGACY_PATHS: JSON.stringify([{ requestPath: '/legacy-dress', targetPath: '/dresses/l1001' }]) });
  const result = await verifyHttp(options, { fetchImpl: fakeFetch, env: {} });
  assert.equal(result.passed, true);
  assert.equal(result.coverage.paymentLink, true);
  assert.equal(result.counts.productIdentities, 1);
  assert.equal(result.counts.legacyRedirects, 1);
  assert.equal(result.counts.cmsPages, 3);
  assert.equal(result.counts.cmsRedirects, 3);
  assert.equal(result.coverage.cmsPages, true);
  assert.equal(result.coverage.cmsLegacyRedirects, true);
  assert.deepEqual(result.skipped, []);
  assert.equal(JSON.stringify(result).includes('WITHHELD'), false);
  assert.equal(JSON.stringify(result).includes('TEST-ONLY'), false);
  assert.equal(calls.filter(call => call.method === 'POST').length, 2);
});

test('bank account settings accidentally exposed in public schema fail acceptance', async () => {
  const options = parseOptions([], {});
  const fakeFetch = async (url, init) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ data: { ...schema, setting: { fields: [{ name: 'bankTransferAccountNumber' }] } } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (url.pathname.endsWith('.svg')) return new Response('<svg>SHUSHA</svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
    if (cmsPaths.includes(url.pathname)) return new Response(cmsPage(), { headers: { 'Content-Type': 'text/html' } });
    if (cmsPaths.includes(url.pathname.replace(/^\/page/, ''))) return new Response('', { status: 301, headers: { Location: url.pathname.slice(5) + url.search } });
    return new Response(page(`<strong>SHUSHA</strong><section class="shusha-hero"><h1>Fixture</h1></section><a href="/dresses"></a><a href="/pants"></a><a href="/tops"></a><img src="/assets/shusha/shusha-wordmark.svg"/>${icons}WhatsApp Wise`), { headers: { 'Content-Type': 'text/html' } });
  };
  await assert.rejects(() => verifyHttp(options, { fetchImpl: fakeFetch, env: {} }), /public-settings-have-no-bank-account-details/);
});

test('native-style CMS redirects that lose the query string fail acceptance', async () => {
  const options = parseOptions([], {});
  const fakeFetch = async (url) => {
    if (url.pathname.endsWith('.svg')) return new Response('<svg>SHUSHA</svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
    if (cmsPaths.includes(url.pathname)) return new Response(cmsPage(), { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname.startsWith('/page/')) return new Response('', { status: 301, headers: { Location: url.pathname.slice(5) } });
    return new Response(page(`<strong>SHUSHA</strong><section class="shusha-hero"><h1>Fixture</h1></section><a href="/dresses"></a><a href="/pants"></a><a href="/tops"></a><img src="/assets/shusha/shusha-wordmark.svg"/>${icons}WhatsApp Wise`), { headers: { 'Content-Type': 'text/html' } });
  };
  await assert.rejects(() => verifyHttp(options, { fetchImpl: fakeFetch, env: {} }), /cms-legacy-redirect-target-and-query/);
});
