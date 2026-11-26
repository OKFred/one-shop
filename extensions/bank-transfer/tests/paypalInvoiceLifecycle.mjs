import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Called only inside integration.mjs after its disposable database identity guard.
export async function testPaypalQuoteLifecycle({ pool, paypalOrder, alternateOrder, customerId, runGraphql }) {
  const { cancelOrder } = await import('@evershop/evershop/oms/services');
  const {
    confirmQuote, getOrderQuote, linkPaypalInvoice, openPaypalInvoice, recordReceipt
  } = await import('../dist/services/orderPayments.js');
  const { invoiceReference } = await import('../dist/services/paypalInvoices.js');
  const { default: openInvoice } = await import('../dist/pages/frontStore/bankTransferPaypalInvoice/index.js');
  const { default: paymentPrivacy } = await import('../dist/pages/frontStore/bankTransferPaypalInvoice/paymentPrivacy[index].js');
  const env = {
    NODE_ENV: 'test', SHUSHA_PAYPAL_ENV: 'sandbox', SHUSHA_PAYPAL_INVOICES_ENABLED: '1',
    SHUSHA_PAYPAL_MERCHANT_EMAIL: 'merchant@example.invalid',
    PAYPAL_CLIENT_ID: crypto.randomUUID(), PAYPAL_SECRET: crypto.randomUUID()
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const invoices = new Map();
  let reads = 0;
  async function visit(orderUuid, revision, customer) {
    const request = {
      params: { orderUuid, quoteRevision: String(revision) },
      getCurrentCustomer: () => customer, isCustomerLoggedIn: () => Boolean(customer)
    };
    const headers = new Map();
    const response = {
      code: 200, headers,
      setHeader(key, value) { headers.set(key.toLowerCase(), value); },
      status(code) { this.code = code; return this; },
      redirect(code, url) { this.code = code; headers.set('location', url); },
      type() { return this; }, send() {}
    };
    await paymentPrivacy(request, response, () => {});
    await openInvoice(request, response);
    assert.match(headers.get('cache-control'), /private, no-store/);
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    return response;
  }
  function issue(quote) {
    const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
    const id = `INV2-${token.match(/.{4}/g).join('-')}`;
    const amount = { value: quote.amount, currency_code: quote.currency };
    const invoice = {
      id, status: 'UNPAID', amount, due_amount: amount,
      invoicer: { email_address: env.SHUSHA_PAYPAL_MERCHANT_EMAIL },
      detail: {
        currency_code: quote.currency, reference: invoiceReference(quote),
        metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${token}` }
      }
    };
    invoices.set(id, invoice);
    return invoice;
  }
  const { uuid } = paypalOrder;
  const quoteInput = { currency: 'GBP', amount: '12.00', expectedQuoteRevision: 0, shippingDeferred: true };
  const receipt = { currency: 'GBP', amount: '12.00', quoteRevision: 1, receivedConfirmed: true, receiptReference: crypto.randomUUID().replaceAll('-', '').toUpperCase() };
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (url, options) => {
      if (url === 'https://api-m.sandbox.paypal.com/v1/oauth2/token' && options.method === 'POST') {
        return Response.json({ access_token: 'fixture', token_type: 'Bearer' });
      }
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api-m.sandbox.paypal.com');
      assert.equal(options.method, 'GET');
      const id = parsed.pathname.match(/^\/v2\/invoicing\/invoices\/(INV2(?:-[A-Z0-9]{4}){4})$/)?.[1];
      assert(invoices.has(id));
      reads++;
      return Response.json(invoices.get(id));
    };
    const owner = { kind: 'customer', customerId };
    const guest = { kind: 'guest' };
    await pool.query('UPDATE "order" SET customer_id=$1 WHERE order_id=$2', [customerId, paypalOrder.order_id]);
    const { quote } = await confirmQuote(uuid, quoteInput);
    const invoice = issue(quote);
    const link = { quoteRevision: 1, invoiceId: invoice.id };
    process.env.SHUSHA_PAYPAL_INVOICES_ENABLED = '0';
    await assert.rejects(linkPaypalInvoice(uuid, link), /unavailable/);
    process.env.SHUSHA_PAYPAL_INVOICES_ENABLED = '1';
    const twins = await Promise.all([linkPaypalInvoice(uuid, link), linkPaypalInvoice(uuid, link)]);
    assert.deepEqual(twins.map(x => x.unchanged).sort(), [false, true]);
    assert.equal((await getOrderQuote(paypalOrder.order_id)).paypalInvoiceLinked, true);
    const buyerQuery = '{ bankTransferPaymentOrder { bankTransferQuote { paypalPaymentUrl } } }';
    const guestView = await runGraphql(buyerQuery, { bankTransferGuestUuid: uuid });
    assert.equal(guestView.errors, undefined);
    assert.equal(guestView.data.bankTransferPaymentOrder.bankTransferQuote.paypalPaymentUrl, null);
    const ownedView = await runGraphql(buyerQuery, { bankTransferGuestUuid: uuid, customer: { customer_id: customerId } });
    assert.equal(ownedView.errors, undefined);
    assert(ownedView.data.bankTransferPaymentOrder.bankTransferQuote.paypalPaymentUrl.includes(uuid));
    assert(!ownedView.data.bankTransferPaymentOrder.bankTransferQuote.paypalPaymentUrl.includes('paypal.com'));
    process.env.SHUSHA_PAYPAL_ENV = 'live';
    const mismatchedView = await runGraphql(buyerQuery, { bankTransferGuestUuid: uuid, customer: { customer_id: customerId } });
    assert.equal(mismatchedView.errors, undefined);
    assert.equal(mismatchedView.data.bankTransferPaymentOrder.bankTransferQuote.paypalPaymentUrl, null);
    process.env.SHUSHA_PAYPAL_ENV = 'sandbox';
    const beforeUnauthorized = reads;
    await assert.rejects(openPaypalInvoice(uuid, 1, guest), /unavailable/);
    await assert.rejects(openPaypalInvoice(uuid, 1, { ...owner, customerId: customerId + 1 }), /unavailable/);
    await assert.rejects(openPaypalInvoice(uuid, 2, owner), /current/);
    assert.equal(reads, beforeUnauthorized);
    for (const [revision, customer] of [[1, { customer_id: customerId + 1 }], [2, { customer_id: customerId }]]) {
      const denied = await visit(uuid, revision, customer);
      assert.equal(denied.code, 404);
      assert.equal(denied.headers.has('location'), false);
    }
    assert.equal(reads, beforeUnauthorized);
    const redirect = await visit(uuid, 1, { customer_id: customerId });
    assert.equal(redirect.code, 302);
    assert.equal(redirect.headers.get('location'), invoice.detail.metadata.recipient_view_url);
    assert.equal(await openPaypalInvoice(uuid, 1, owner), invoice.detail.metadata.recipient_view_url);
    assert.equal((await getOrderQuote(paypalOrder.order_id)).status, 'confirmed');

    const alternate = (await confirmQuote(alternateOrder.uuid, quoteInput)).quote;
    invoice.detail.reference = invoiceReference(alternate);
    await assert.rejects(linkPaypalInvoice(alternateOrder.uuid, link), /belongs/);
    invoice.detail.reference = invoiceReference(quote);
    const alternateInvoice = issue(alternate);
    await linkPaypalInvoice(alternateOrder.uuid, { ...link, invoiceId: alternateInvoice.id });
    assert.equal(await openPaypalInvoice(alternateOrder.uuid, 1, guest), alternateInvoice.detail.metadata.recipient_view_url);
    const changed = { ...quoteInput, amount: '11.00', expectedQuoteRevision: 1 };
    await assert.rejects(confirmQuote(uuid, changed), /must be cancelled/);
    await assert.rejects(confirmQuote(uuid, { ...quoteInput, expectedQuoteRevision: 1, renewPaypalInvoice: true }), /must be cancelled/);
    await assert.rejects(cancelOrder(alternateOrder.uuid, 'fixture'), /must be cancelled/);
    await assert.rejects(recordReceipt(alternateOrder.uuid, receipt), /must be cancelled/);
    alternateInvoice.status = 'CANCELLED';
    assert.equal((await recordReceipt(alternateOrder.uuid, receipt)).quote.status, 'paid');
    assert.equal((await recordReceipt(alternateOrder.uuid, receipt)).alreadyRecorded, true);
    await assert.rejects(cancelOrder(alternateOrder.uuid, 'fixture'));
    assert.equal((await getOrderQuote(alternateOrder.order_id)).status, 'paid');

    invoice.status = 'CANCELLED';
    const { quote: renewed } = await confirmQuote(uuid, { ...quoteInput, expectedQuoteRevision: 1, renewPaypalInvoice: true });
    assert.equal(renewed.revision, 2);
    assert.equal(renewed.paypalInvoiceLinked, false);
    await assert.rejects(openPaypalInvoice(uuid, 1, owner), /current/);
    const secondInvoice = issue(renewed);
    await linkPaypalInvoice(uuid, { ...link, invoiceId: secondInvoice.id, quoteRevision: 2 });
    secondInvoice.status = 'CANCELLED';
    const { quote: repriced } = await confirmQuote(uuid, { ...changed, expectedQuoteRevision: 2 });
    assert.equal(repriced.revision, 3);
    const thirdInvoice = issue(repriced);
    await linkPaypalInvoice(uuid, { ...link, invoiceId: thirdInvoice.id, quoteRevision: 3 });
    const actual = {
      ...receipt, amount: repriced.amount, quoteRevision: 3, receiptChannel: 'paypal',
      receiptReference: crypto.randomUUID().replaceAll('-', '').toUpperCase()
    };
    await assert.rejects(recordReceipt(uuid, actual), /could not verify/);
    thirdInvoice.status = 'PAID';
    thirdInvoice.due_amount = { currency_code: 'GBP', value: '0.00' };
    thirdInvoice.payments = {
      paid_amount: thirdInvoice.amount,
      transactions: [{ type: 'PAYPAL', payment_id: actual.receiptReference, amount: thirdInvoice.amount }]
    };
    await assert.rejects(openPaypalInvoice(uuid, 3, owner), /not payable/);
    await assert.rejects(recordReceipt(uuid, { ...actual, receivedConfirmed: false }), /Verify actual/);
    await assert.rejects(recordReceipt(uuid, { ...actual, receiptReference: 'DIFFERENT' }), /could not verify/);
    assert.equal((await recordReceipt(uuid, actual)).quote.status, 'paid');
    assert.equal((await recordReceipt(uuid, actual)).alreadyRecorded, true);
    await assert.rejects(recordReceipt(uuid, { ...actual, receiptChannel: 'bank' }), /already/);
    const { rows: [record] } = await pool.query(`SELECT r.channel, t.transaction_id, t.additional_information, o.grand_total, o.shipment_status
      FROM shusha_payment_receipt r JOIN "order" o ON o.order_id=r.order_id
      JOIN payment_transaction t ON t.payment_transaction_order_id=o.order_id
      WHERE r.order_id=$1`, [paypalOrder.order_id]);
    assert.equal(record.channel, 'paypal');
    assert.equal(record.transaction_id, `paypal-manual:${actual.receiptReference}`);
    assert.equal(JSON.parse(record.additional_information).provider, 'paypal-invoice');
    assert.equal(record.grand_total, paypalOrder.grand_total);
    assert.equal(record.shipment_status, paypalOrder.shipment_status);
    const history = await pool.query('SELECT invoice_id, recipient_url FROM shusha_paypal_invoice WHERE order_id=$1 ORDER BY quote_revision', [paypalOrder.order_id]);
    assert.deepEqual(history.rows, [invoice, secondInvoice, thirdInvoice].map(doc => ({
      invoice_id: doc.id, recipient_url: doc.detail.metadata.recipient_view_url
    })));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
