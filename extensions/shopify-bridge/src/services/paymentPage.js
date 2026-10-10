import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BrandIcon from '@shusha/storefront-brand/components/BrandIcon';
import { normalizeShop } from './config.js';
import { decimalMoney } from './payments.js';

const css = `*{box-sizing:border-box}body{margin:0;background:#f7f6f1;color:#263225;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6}main{max-width:760px;margin:0 auto;padding:32px 24px 56px}.brand{font-size:20px;font-weight:700;letter-spacing:.18em}h1{font-size:30px;line-height:1.25;margin:24px 0}h2{font-size:20px;margin:0 0 12px}p{margin:12px 0}.amount{border:1px solid #d5d8d0;background:#fff;border-radius:12px;padding:24px;margin:20px 0;display:grid;gap:8px}.amount strong{font-size:36px;line-height:1.25}.reference{overflow-wrap:anywhere}.wise{display:flex;align-items:center;justify-content:center;gap:12px;min-height:48px;min-width:220px;width:max-content;max-width:100%;padding:12px 24px;border:1px solid #303e2c;border-radius:8px;background:#303e2c;color:#fff;text-decoration:none;font-weight:650;font-size:17px}.wise svg{flex-shrink:0;color:currentColor}.wise:hover{background:#4c5e43;border-color:#4c5e43}.wise:focus-visible,a:focus-visible{outline:3px solid #303e2c;outline-offset:4px}.bank{margin:28px 0;padding:24px;background:#fff;border:1px solid #d5d8d0;border-radius:12px}dl{margin:0}dl>div{display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,2fr);gap:16px;padding:12px 0;border-bottom:1px solid #e2e4df}dt{color:#62655e}dd{margin:0;font-weight:600;overflow-wrap:anywhere}.status{padding:16px;border-left:3px solid #8d946e;background:#fff}.back{color:#303e2c;font-weight:600}.note{font-size:14px;color:#62655e}@media(max-width:480px){main{padding:24px 16px 40px}h1{font-size:26px}.wise{width:100%;min-width:0}.bank{padding:20px}dl>div{grid-template-columns:1fr;gap:4px}.amount strong{font-size:32px}}`;
export const paymentPageCsp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; style-src-attr 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
function escape(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
function document(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>SHUSHA order payment</title><style>${css}</style></head><body><main><div class="brand">SHUSHA</div>${body}</main></body></html>`;
}
function paymentUrl(quote) {
  if (!quote.wisePaymentUrl) return null;
  const url = new URL(quote.wisePaymentUrl);
  if (url.origin !== 'https://wise.com' || url.username || url.password || url.hash || !/^\/pay\/business\/[A-Za-z0-9._~-]+\/?$/.test(url.pathname)
    || [...url.searchParams.keys()].sort().join(',') !== 'amount,currency,description' || url.searchParams.get('amount') !== quote.amount || url.searchParams.get('currency') !== 'USD' || url.searchParams.get('description') !== quote.reference) throw new Error('Confirmed Wise payment fields differ');
  return url.href;
}
export function renderPaymentPage({ quote, shop, expiresAt }) {
  normalizeShop(shop);
  if (!['confirmed', 'partial'].includes(quote?.status) || quote.currency !== 'USD' || !Number.isSafeInteger(quote.revision) || quote.revision < 1 || !Number.isSafeInteger(expiresAt) || typeof quote.reference !== 'string' || quote.reference.length > 120) throw new Error('Current customer payment quote is required');
  decimalMoney(quote.amount);
  if (!Array.isArray(quote.bankDetails) || !quote.bankDetails.length || quote.bankDetails.length > 16) throw new Error('Verified bank transfer details are unavailable');
  const fields = quote.bankDetails.map(({ label, value }) => {
    if (typeof label !== 'string' || typeof value !== 'string' || !label.trim() || !value.trim() || label.length > 100 || value.length > 500) throw new Error('Invalid receiving fields');
    return `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
  }).join('');
  const wise = paymentUrl(quote);
  // Existing Iconify /offline component renders only bundled trusted SVG. Strip
  // its static inline style so the page can enforce style-src-attr 'none'.
  const icon = renderToStaticMarkup(React.createElement(BrandIcon, { brand: 'wise', size: 24 })).replace(/ style="[^"]*"/g, '');
  return document(`<h1>Order payment</h1><p>Your order and shipping quote have been confirmed by our team.</p>
    <section class="amount" aria-label="Confirmed payment amount"><span>${quote.status === 'partial' ? 'Remaining amount to pay' : 'Confirmed amount to pay'}</span><strong>USD ${escape(quote.amount)}</strong><span class="reference">Payment reference: <strong>${escape(quote.reference)}</strong></span></section>
    ${wise ? `<a class="wise" href="${escape(wise)}" target="_blank" rel="noopener noreferrer">${icon}<span>Pay with Wise</span></a><p>Check that Wise shows <strong>USD ${escape(quote.amount)}</strong> and reference <strong>${escape(quote.reference)}</strong> before paying. Wise may allow these fields to be edited.</p>` : ''}
    <section class="bank"><h2>${wise ? 'Or pay by bank transfer' : 'Pay by bank transfer'}</h2><p>Send <strong>USD ${escape(quote.amount)}</strong> using the verified details below. Include your payment reference.</p><dl>${fields}<div><dt>Payment reference</dt><dd>${escape(quote.reference)}</dd></div></dl><p class="note">Your bank or Wise may charge a transfer fee. Check the amount the recipient will receive before confirming.</p></section>
    <p class="status">Your order stays unpaid until our team verifies that the confirmed amount has arrived. Opening Wise or returning to this page does not confirm payment.</p>
    <p class="note">This payment entry expires shortly. Return to your account and open a fresh entry if the quote has changed.</p><p><a class="back" href="https://${shop}/account">Return to your account</a></p>`);
}
export function renderUnavailablePaymentPage() {
  return document('<h1>Payment entry unavailable</h1><p>No payable confirmed balance is currently available. Check your order status or refresh your payment entry. Contact the merchant if you need help.</p>');
}
