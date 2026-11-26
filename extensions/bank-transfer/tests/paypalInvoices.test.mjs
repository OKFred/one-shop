import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPaypalInvoice, invoiceReference, paypalInvoiceEnvironment, paypalInvoicesEnabled,
  verifyPayableInvoice, verifyPaidInvoice, verifyRetiredInvoice
} from '../src/services/paypalInvoices.js';

const sandbox = {
  SHUSHA_PAYPAL_INVOICES_ENABLED: '1',
  SHUSHA_PAYPAL_ENV: 'sandbox',
  SHUSHA_PAYPAL_MERCHANT_EMAIL: 'billing@example.invalid',
  PAYPAL_CLIENT_ID: 'synthetic-client',
  PAYPAL_SECRET: 'synthetic-secret',
  NODE_ENV: 'test',
  DB_NAME: 'disposable_test'
};
let original;
beforeEach(() => {
  original = Object.fromEntries(Object.keys(sandbox).map(key => [key, process.env[key]]));
  Object.assign(process.env, sandbox);
});
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const id = 'INV2-ABCD-EFGH-1234-5678';
const link = 'https://www.sandbox.paypal.com/invoice/p/#ABCDEFGH12345678';
const quote = { reference: 'SHUSHA-10004', revision: 2, currency: 'USD', amount: '12.99' };
const amount = () => ({ currency_code: 'USD', value: '12.99' });
function invoice() {
  return {
    id, status: 'UNPAID',
    detail: { reference: 'SHUSHA-10004-R2', currency_code: 'USD', metadata: { recipient_view_url: link } },
    invoicer: { email_address: 'Billing@Example.Invalid' },
    amount: amount(), due_amount: amount()
  };
}

test('Only the explicitly selected, configured provider environment becomes available', () => {
  assert.equal(paypalInvoicesEnabled(), true);
  assert.equal(paypalInvoiceEnvironment(), 'sandbox');
  for (const key of ['SHUSHA_PAYPAL_INVOICES_ENABLED', 'SHUSHA_PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'SHUSHA_PAYPAL_MERCHANT_EMAIL']) {
    delete process.env[key];
    assert.equal(paypalInvoicesEnabled(), false);
    process.env[key] = sandbox[key];
  }
  process.env.DB_NAME = 'shusha_v2_production';
  assert.equal(paypalInvoicesEnabled(), false);
  process.env.DB_NAME = 'other';
  process.env.NODE_ENV = 'production';
  assert.equal(paypalInvoicesEnabled(), false);
  process.env.DB_NAME = 'shusha_paypal_candidate';
  assert.equal(paypalInvoicesEnabled(), true);
  process.env.DB_NAME = 'shusha_v2_production';
  assert.equal(paypalInvoicesEnabled(), false);
  process.env.SHUSHA_PAYPAL_ENV = 'live';
  assert.equal(paypalInvoicesEnabled(), true);
  assert.throws(() => verifyPayableInvoice(invoice(), quote), /buyer invoice link/);
});

test('Only an OAuth token exchange and the requested merchant invoice GET are dispatched', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return Response.json(requests.length === 1 ? { token_type: 'Bearer', access_token: 'synthetic-token' } : invoice());
  });
  await assert.rejects(getPaypalInvoice('../unrelated'), /Invalid PayPal/);
  assert.equal(requests.length, 0);
  assert.deepEqual(await getPaypalInvoice(id), invoice());
  assert.deepEqual(requests.map(({url, options}) => [url, options.method, options.redirect]), [
    ['https://api-m.sandbox.paypal.com/v1/oauth2/token', 'POST', 'error'],
    [`https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}`, 'GET', 'error']
  ]);
  assert.equal(requests[1].options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(requests[1].options.body, undefined);
});

test('An unavailable authorization and an unexpected returned invoice never expose provider details', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('PRIVATE_DIAGNOSTIC', { status: 403 }));
  await assert.rejects(getPaypalInvoice(id), { message: 'PayPal invoice verification is temporarily unavailable' });
  fetch.mock.mockImplementation(async (url, options) => Response.json(options.method === 'POST'
    ? { token_type: 'Bearer', access_token: 'synthetic' } : { ...invoice(), id: 'INV2-ZZZZ-ZZZZ-ZZZZ-ZZZZ' }));
  await assert.rejects(getPaypalInvoice(id), /different invoice/);
});

test('Payable invoice requires the current reference, amount, currency, merchant and a payer link for that exact ID', () => {
  assert.equal(invoiceReference(quote), 'SHUSHA-10004-R2');
  for (const status of ['UNPAID', 'SENT', 'SHARED']) {
    assert.equal(verifyPayableInvoice({ ...invoice(), status }, quote), link);
  }
  for (const mutate of [
    i => { i.detail.reference = 'SHUSHA-10004-R1'; },
    i => { i.detail.reference = 'SHUSHA-10005-R2'; },
    i => { i.invoicer.email_address = 'other@example.invalid'; },
    i => { i.amount.currency_code = 'GBP'; },
    i => { i.detail.currency_code = 'GBP'; },
    i => { i.due_amount.value = '11.99'; },
    i => { i.amount.value = '12.991'; },
    i => { i.configuration = { allow_tip: true }; },
    i => { i.configuration = { has_conditional_rule: true }; },
    i => { i.configuration = { payment_method_overrides: [{ payment_method_type: 'ACH', enabled: true }] }; },
    i => { i.configuration = { partial_payment: { allow_partial_payment: true } }; },
    i => { i.gratuity = amount(); },
    i => { i.amount.breakdown = { shipping: { amount: amount() } }; },
    i => { i.payments = { paid_amount: amount() }; },
    i => { i.refunds = { transactions: [{}] }; },
    i => { i.status = 'DRAFT'; }, i => { i.status = 'PAID'; },
    i => { i.status = 'PAYMENT_PENDING'; }, i => { i.status = 'PARTIALLY_PAID'; },
    i => { i.detail.metadata.recipient_view_url = link.replace('ABCDEFGH', 'ZZZZZZZZ'); },
    i => { i.detail.metadata.recipient_view_url = link.replace('paypal.com', 'paypal.com.example.invalid'); },
    i => { i.detail.metadata.recipient_view_url = link.replace('/invoice/p/', '/withdraw/product/service/profile'); },
    i => { i.detail.metadata.recipient_view_url = link.replace('www.sandbox.', 'www.'); }
  ]) {
    const result = invoice();
    mutate(result);
    assert.throws(() => verifyPayableInvoice(result, quote));
  }
});

test('Replacing an invoice requires the same cancelled merchant invoice without financial activity', () => {
  const cancelled = { ...invoice(), status: 'CANCELLED' };
  assert.equal(verifyRetiredInvoice(cancelled, id), true);
  assert.equal(verifyRetiredInvoice({ ...cancelled, status: 'AUTO_CANCELLED' }, id), true);
  for (const status of ['PAID', 'REFUNDED', 'UNPAID', 'DRAFT', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'MARKED_AS_PAID', 'UNKNOWN']) {
    assert.throws(() => verifyRetiredInvoice({ ...cancelled, status }, id));
  }
  assert.throws(() => verifyRetiredInvoice(cancelled, 'INV2-ZZZZ-ZZZZ-ZZZZ-ZZZZ'));
  assert.throws(() => verifyRetiredInvoice({ ...cancelled, payments: { transactions: [{}] } }, id));
  assert.throws(() => verifyRetiredInvoice({ ...cancelled, refunds: { refund_amount: amount() } }, id));
  assert.throws(() => verifyRetiredInvoice({ ...cancelled, invoicer: {} }, id));
});

test('Manual receipt requires one provider payment matching the full quoted amount and transaction reference', () => {
  const receipt = 'EXAMPLE1234567890';
  const paid = () => ({
    ...invoice(), status: 'PAID', due_amount: { currency_code: 'USD', value: '0.00' },
    payments: { paid_amount: amount(), transactions: [{ type: 'PAYPAL', payment_id: receipt, method: 'PAYPAL', amount: amount() }] }
  });
  assert.equal(verifyPaidInvoice(paid(), quote, receipt), true);
  assert.throws(() => verifyPaidInvoice(paid(), quote, 'DIFFERENT'));
  for (const mutate of [
    i => { i.status = 'MARKED_AS_PAID'; },
    i => { i.payments.transactions[0].type = 'EXTERNAL'; },
    i => { i.payments.transactions[0].amount.value = '12.98'; },
    i => { i.payments.transactions.push(i.payments.transactions[0]); },
    i => { i.refunds = { refund_amount: amount() }; },
    i => { i.payments.paid_amount.currency_code = 'EUR'; },
    i => { i.due_amount.value = '1.00'; }
  ]) {
    const result = paid();
    mutate(result);
    assert.throws(() => verifyPaidInvoice(result, quote, receipt));
  }
});
