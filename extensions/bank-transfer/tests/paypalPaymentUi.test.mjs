import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The storefront bundler normally handles component styles.
register('data:text/javascript,' + encodeURIComponent(`
  export function load(url, context, nextLoad) {
    if (url.endsWith('.scss')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`), import.meta.url);
const { default: QuoteNotice } = await import('../dist/pages/frontStore/checkout/QuoteNotice.js');
const { default: PaymentPanel } = await import('../dist/components/BankTransferPaymentPanel.js');
const { default: Confirmation } = await import('../dist/pages/frontStore/checkoutSuccess/BankTransferConfirmation.js');
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const quote = { status: 'confirmed', revision: 2, amount: '19.98', currency: 'USD', merchandiseUsd: '19.98', reference: 'SHUSHA-TEST-01', paypalPaymentUrl: '/synthetic/invoice/2' };

test('Checkout and confirmed quote show a labelled disabled WIP control without a payment href', () => {
  for (const html of [render(QuoteNotice, { setting: { bankTransferPaymentStatus: 1 } }), render(PaymentPanel, { quote, setting: {} })]) {
    const description = html.match(/<button type="button" disabled="" aria-describedby="([^"]+)">PayPal · WIP<\/button>/);
    assert.ok(description);
    assert.ok(html.includes(`id="${description[1]}">PayPal payments are not available yet.`));
    assert.doesNotMatch(html, /href=|\/synthetic\/invoice/);
  }
});

test('PayPal link needs a confirmed quote and an enabled, linked invoice', () => {
  const setting = { bankTransferPaypalEnabled: true };
  const html = render(PaymentPanel, { quote, setting });
  assert.match(html, /href="\/synthetic\/invoice\/2"[^>]*>Pay with PayPal<\/a>/);
  for (const expected of ['USD 19.98', 'SHUSHA-TEST-01']) assert.ok(html.includes(expected));
  const pending = render(PaymentPanel, { setting });
  assert.match(pending, /after quote confirmation/);
  const awaitingInvoice = render(PaymentPanel, { quote: { ...quote, paypalPaymentUrl: null }, setting });
  assert.match(awaitingInvoice, /PayPal invoice/);
  for (const unavailable of [pending, awaitingInvoice, render(PaymentPanel, { quote: { ...quote, status: 'paid' }, setting }), render(PaymentPanel, { quote, setting, paid: true })]) {
    assert.doesNotMatch(unavailable, /Pay with PayPal|\/synthetic\/invoice|PayPal · WIP/);
  }
});

test('A cancelled order or shipment suppresses checkout-success payment actions', () => {
  const order = { orderNumber: 'TEST-01', paymentMethod: 'banktransfer', paymentStatus: { code: 'pending' }, bankTransferQuote: quote, bankTransferPaymentUrl: '/synthetic/payment' };
  for (const terminal of [{ status: { code: 'cancelled' } }, { status: { code: 'closed' } }, { shipmentStatus: { code: 'canceled' } }]) {
    const html = render(Confirmation, { order: { ...order, ...terminal }, setting: { bankTransferPaypalEnabled: true } });
    assert.doesNotMatch(html, /\/synthetic|Pay with PayPal|PayPal · WIP/);
  }
});
