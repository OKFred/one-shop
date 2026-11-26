
import { pool } from '@evershop/evershop/lib/postgres';
import { updatePaymentStatus } from '@evershop/evershop/oms/services';
import { buildUrl } from '@evershop/evershop/lib/router';
import { startTransaction } from '@evershop/postgres-query-builder';
import * as validation from './paymentValidation.js';
import { loadReceivingConfig } from './receivingConfig.js';
import { isEnabled } from './settings.js';
import { claimNativeReceipt } from './globalReceipt.js';
import { canOpenPaypalInvoice } from './paymentAccess.js';
import {
  getPaypalInvoice, paypalInvoiceEnvironment, paypalInvoicesEnabled, verifyPaidInvoice,
  verifyPayableInvoice, verifyRetiredInvoice
} from './paypalInvoices.js';

function publicQuote(row) {
  if (!row) return null;
  return {
    status: row.status,
    revision: row.revision,
    currency: row.currency,
    amount: validation.money(String(row.amount)),
    merchandiseUsd: validation.usdMoney(row.merchandise_usd),
    reference: row.reference,
    wisePaymentUrl: row.wise_payment_url,
    paypalInvoiceLinked: row.paypal_invoice_linked === true,
    bankDetails: row.bank_details,
    receiptConfirmedAt: row.receipt_confirmed_at ? new Date(row.receipt_confirmed_at).toISOString() : null,
    shippingDeferred: true
  };
}
function customerUrl(uuid) { return buildUrl('bankTransferPayment', { orderUuid: uuid }); }
function assertOrder(order, { allowPaid = false } = {}) {
  if (!order || order.payment_method !== 'banktransfer') throw new Error('A T/T order request is required');
  if (['canceled', 'cancelled', 'closed'].includes(order.status) || ['canceled', 'cancelled'].includes(order.shipment_status) || ['canceled', 'cancelled'].includes(order.payment_status)) throw new Error('This order cannot receive a payment quote');
  if (order.payment_status !== 'pending' && !(allowPaid && order.payment_status === 'paid')) throw new Error('The order is not awaiting payment');
  if (order.currency !== 'USD' || Number(order.shipping_fee_incl_tax) !== 0) throw new Error('This flow requires a USD merchandise order with shipping deferred');
  validation.usdMoney(order.grand_total);
}
async function getOrderQuote(orderId, connection = pool) {
  const result = await connection.query(`SELECT q.*, i.invoice_id IS NOT NULL AS paypal_invoice_linked, i.environment AS paypal_environment
    FROM shusha_payment_quote q JOIN "order" o ON o.order_id=q.order_id
    LEFT JOIN shusha_paypal_invoice i ON i.order_id=q.order_id AND i.quote_revision=q.revision
    WHERE q.order_id=$1 AND o.payment_method='banktransfer' AND o.currency='USD'
    AND o.grand_total=q.merchandise_usd AND o.shipping_fee_incl_tax=0
    AND ((o.payment_status='pending' AND q.status='confirmed') OR (o.payment_status='paid' AND q.status='paid'))
    AND COALESCE(o.status,'') NOT IN ('canceled','cancelled','closed')
    AND COALESCE(o.shipment_status,'') NOT IN ('canceled','cancelled')`, [orderId]);
  const row = result.rows[0];
  if (!row) return null;
  return { ...publicQuote(row), paypalInvoiceEnvironmentMatches: Boolean(row.paypal_environment) && row.paypal_environment === paypalInvoiceEnvironment() };
}
async function transaction(work) {
  const client = await pool.connect();
  try {
    // Native query-builder calls release a client unless its transaction flag
    // is set. Use its starter even though our own writes use parameterized SQL.
    await startTransaction(client);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.INTRANSACTION = false; client.release(); }
}
async function loadLockedOrder(client, uuid) {
  validation.validateOrderUuid(uuid);
  return (await client.query('SELECT * FROM "order" WHERE uuid=$1 FOR UPDATE', [uuid])).rows[0];
}
async function invoiceBinding(client, orderId, revision) {
  return (await client.query(
    'SELECT * FROM shusha_paypal_invoice WHERE order_id=$1 AND quote_revision=$2',
    [orderId, revision]
  )).rows[0];
}
async function readBoundInvoice(binding) {
  if (binding.environment !== paypalInvoiceEnvironment()) throw new Error('PayPal invoice environment does not match this quote');
  return getPaypalInvoice(binding.invoice_id);
}
async function requireRetiredInvoice(binding) {
  if (binding) verifyRetiredInvoice(await readBoundInvoice(binding), binding.invoice_id);
}
// Called within the native cancellation transaction. Serialize with first-time invoice linking too.
async function beforeCancelOrderPayment(orderId, client) {
  const order = (await client.query(`SELECT order_id,payment_status,status,shipment_status FROM "order"
    WHERE order_id=$1 AND payment_method='banktransfer' FOR UPDATE`, [orderId])).rows[0];
  if (!order) return;
  const binding = (await client.query(`SELECT i.* FROM shusha_paypal_invoice i
    JOIN shusha_payment_quote q ON i.order_id=q.order_id AND i.quote_revision=q.revision
    WHERE i.order_id=$1`, [orderId])).rows[0];
  if (binding) {
    if (order.payment_status !== 'pending' || ['closed','canceled','cancelled'].includes(order.status) ||
        ['canceled','cancelled'].includes(order.shipment_status)) throw new Error('Only a pending PayPal-linked order can be cancelled');
    await requireRetiredInvoice(binding);
  }
}
async function currentPaypalQuote(client, order, revision) {
  assertOrder(order);
  const quote = (await client.query('SELECT * FROM shusha_payment_quote WHERE order_id=$1 FOR UPDATE', [order.order_id])).rows[0];
  if (!quote || quote.revision !== revision || quote.status !== 'confirmed' ||
      validation.usdMoney(quote.merchandise_usd) !== validation.usdMoney(order.grand_total)) {
    throw new Error('A current confirmed payment quote is required');
  }
  return publicQuote(quote);
}
async function linkPaypalInvoice(uuid, { invoiceId, quoteRevision }) {
  if (!(await isEnabled()) || !paypalInvoicesEnabled()) throw new Error('PayPal invoices are unavailable');
  return transaction(async (client) => {
    const order = await loadLockedOrder(client, uuid);
    const quote = await currentPaypalQuote(client, order, quoteRevision);
    const bound = await invoiceBinding(client, order.order_id, quoteRevision);
    if (bound && (bound.invoice_id !== invoiceId || bound.environment !== paypalInvoiceEnvironment())) {
      throw new Error('This quote already has a PayPal invoice. Retire it and issue a new quote revision first.');
    }
    const url = verifyPayableInvoice(await getPaypalInvoice(invoiceId), quote);
    if (bound && bound.recipient_url !== url) throw new Error('The linked PayPal invoice URL has changed');
    if (!bound) {
      const inserted = await client.query(`INSERT INTO shusha_paypal_invoice
        (order_id,quote_revision,environment,invoice_id,recipient_url) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (environment,invoice_id) DO NOTHING RETURNING order_id`,
        [order.order_id, quoteRevision, paypalInvoiceEnvironment(), invoiceId, url]);
      if (!inserted.rowCount) throw new Error('This PayPal invoice already belongs to another quote');
    }
    return { quote: { ...quote, paypalInvoiceLinked: true }, unchanged: Boolean(bound) };
  });
}
async function openPaypalInvoice(uuid, revision, access) {
  if (!(await isEnabled()) || !paypalInvoicesEnabled()) throw new Error('PayPal invoices are unavailable');
  return transaction(async (client) => {
    const order = await loadLockedOrder(client, uuid);
    if (!canOpenPaypalInvoice(order, access)) throw new Error('Payment page unavailable');
    const quote = await currentPaypalQuote(client, order, revision);
    const binding = await invoiceBinding(client, order.order_id, revision);
    if (!binding) throw new Error('No PayPal invoice is linked');
    const url = verifyPayableInvoice(await readBoundInvoice(binding), quote);
    if (binding.recipient_url !== url) throw new Error('The linked PayPal invoice URL has changed');
    return url;
  });
}
async function confirmQuote(uuid, payload) {
  if (!(await isEnabled())) throw new Error('T/T payments are disabled');
  const denomination = validation.currency(payload.currency);
  const amount = validation.money(payload.amount);
  if (payload.shippingDeferred !== true) throw new Error('Shipping must remain explicitly deferred');
  if (!Number.isSafeInteger(payload.expectedQuoteRevision) || payload.expectedQuoteRevision < 0) throw new Error('The expected quote revision is required');
  const config = loadReceivingConfig();
  const account = config.accounts[denomination];
  if (!account) throw new Error('This currency has no configured issued receiving account');
  return transaction(async (client) => {
    const order = await loadLockedOrder(client, uuid);
    assertOrder(order);
    const previous = (await client.query('SELECT * FROM shusha_payment_quote WHERE order_id=$1 FOR UPDATE', [order.order_id])).rows[0];
    if (previous?.status === 'paid') throw new Error('A received payment quote cannot be changed');
    const merchandiseUsd = validation.usdMoney(order.grand_total);
    const reference = `SHUSHA-${order.order_number}`;
    const wisePaymentUrl = validation.paymentLink(config.openLink, amount, denomination, reference);
    // USD means the original USD merchandise amount, never an arbitrary partial
    // payment. GBP/EUR amounts are explicit manually agreed conversion quotes.
    if (denomination === 'USD' && amount !== merchandiseUsd) throw new Error('The USD quote must match the full merchandise amount');
    const binding = previous && await invoiceBinding(client, order.order_id, previous.revision);
    if (payload.renewPaypalInvoice === true && !binding) throw new Error('There is no linked PayPal invoice to renew');
    if (payload.renewPaypalInvoice !== true && previous && previous.currency === denomination && validation.money(String(previous.amount)) === amount && validation.usdMoney(previous.merchandise_usd) === merchandiseUsd && JSON.stringify(previous.bank_details) === JSON.stringify(account.fields) && previous.wise_payment_url === wisePaymentUrl) return { quote: publicQuote({ ...previous, paypal_invoice_linked: !!binding }), paymentUrl: customerUrl(uuid), unchanged: true };
    if (payload.expectedQuoteRevision !== (previous?.revision || 0)) throw new Error('The payment quote changed; refresh before confirming another amount');
    const revision = previous ? previous.revision + 1 : 1;
    await requireRetiredInvoice(binding);
    const row = (await client.query(`INSERT INTO shusha_payment_quote(order_id,revision,currency,amount,merchandise_usd,reference,bank_details,wise_payment_url,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'confirmed') ON CONFLICT(order_id) DO UPDATE SET revision=EXCLUDED.revision,currency=EXCLUDED.currency,amount=EXCLUDED.amount,merchandise_usd=EXCLUDED.merchandise_usd,reference=EXCLUDED.reference,bank_details=EXCLUDED.bank_details,wise_payment_url=EXCLUDED.wise_payment_url,status='confirmed',confirmed_at=CURRENT_TIMESTAMP RETURNING *`, [order.order_id, revision, denomination, amount, merchandiseUsd, reference, JSON.stringify(account.fields), wisePaymentUrl])).rows[0];
    await client.query('INSERT INTO shusha_payment_quote_audit(order_id,revision,snapshot) VALUES($1,$2,$3)', [order.order_id, revision, JSON.stringify(publicQuote(row))]);
    await client.query('INSERT INTO order_activity(order_activity_order_id,comment,customer_notified) VALUES($1,$2,FALSE)', [order.order_id, `Payment quote revision ${revision}: ${denomination} ${amount} for USD ${merchandiseUsd} merchandise. Shipping deferred; customer not automatically notified.`]);
    return { quote: publicQuote(row), paymentUrl: customerUrl(uuid) };
  });
}
async function recordReceipt(uuid, payload) {
  if (!(await isEnabled())) throw new Error('T/T payments are disabled');
  const denomination = validation.currency(payload.currency);
  const amount = validation.money(payload.amount);
  const reference = validation.receiptReference(payload.receiptReference);
  const channel = payload.receiptChannel === undefined ? 'bank' : payload.receiptChannel;
  if (!['bank', 'paypal'].includes(channel)) throw new Error('Unknown receipt channel');
  if (payload.receivedConfirmed !== true) throw new Error('Verify actual funds received before registering payment');
  if (!Number.isSafeInteger(payload.quoteRevision) || payload.quoteRevision < 1) throw new Error('The current quote revision is required');
  return transaction(async (client) => {
    const order = await loadLockedOrder(client, uuid);
    assertOrder(order, { allowPaid: true });
    const quote = (await client.query('SELECT * FROM shusha_payment_quote WHERE order_id=$1 FOR UPDATE', [order.order_id])).rows[0];
    if (!quote) throw new Error('Confirm the payment quote first');
    if (quote.revision !== payload.quoteRevision) throw new Error('The payment quote changed; refresh and verify the current quote');
    if (quote.currency !== denomination || validation.money(String(quote.amount)) !== amount) throw new Error('Received amount and currency must exactly match the current quote');
    if (validation.usdMoney(quote.merchandise_usd) !== validation.usdMoney(order.grand_total)) throw new Error('The merchandise total changed; review and reconfirm the quote');
    const priorReceipt = (await client.query('SELECT * FROM shusha_payment_receipt WHERE order_id=$1', [order.order_id])).rows[0];
    if (priorReceipt) {
      if (priorReceipt.channel === channel && priorReceipt.receipt_reference === reference && priorReceipt.currency === denomination && validation.money(String(priorReceipt.amount)) === amount && quote.status === 'paid' && order.payment_status === 'paid') {
        await claimNativeReceipt(client, { reference, orderUuid: order.uuid, currency: denomination, amount, quoteRevision: quote.revision });
        return { quote: publicQuote(quote), paymentUrl: customerUrl(uuid), alreadyRecorded: true };
      }
      throw new Error('This order already has a registered receipt');
    }
    if (order.payment_status !== 'pending' || quote.status !== 'confirmed') throw new Error('This order is not awaiting the quoted payment');
    const binding = await invoiceBinding(client, order.order_id, quote.revision);
    if (channel === 'paypal') {
      if (!binding) throw new Error('PayPal receipts require a linked invoice on this quote');
      verifyPaidInvoice(await readBoundInvoice(binding), publicQuote(quote), reference);
    } else {
      await requireRetiredInvoice(binding);
    }
    await claimNativeReceipt(client, { reference, orderUuid: order.uuid, currency: denomination, amount, quoteRevision: quote.revision });
    await client.query('INSERT INTO shusha_payment_receipt(order_id,quote_revision,receipt_reference,currency,amount,merchandise_usd,channel) VALUES($1,$2,$3,$4,$5,$6,$7)', [order.order_id, quote.revision, reference, denomination, amount, quote.merchandise_usd, channel]);
    // Use the native USD order basis for EverShop accounting. Actual received
    // currency/amount live in the receipt and transaction metadata, not totals.
    const rail = channel === 'paypal' ? 'paypal' : 'wise';
    const provider = channel === 'paypal' ? 'paypal-invoice' : 'wise-bank-transfer';
    await client.query(`INSERT INTO payment_transaction(payment_transaction_order_id,transaction_id,transaction_type,amount,payment_action,additional_information) VALUES($1,$2,'offline',$3,'capture',$4)`, [order.order_id, `${rail}-manual:${reference}`, quote.merchandise_usd, JSON.stringify({ provider, manualReceiptVerified: true, receiptReference: reference, receivedCurrency: denomination, receivedAmount: amount, orderCurrency: 'USD', quoteRevision: quote.revision, shippingDeferred: true })]);
    await updatePaymentStatus(order.order_id, 'paid', client);
    const updated = (await client.query("UPDATE shusha_payment_quote SET status='paid',receipt_confirmed_at=CURRENT_TIMESTAMP WHERE order_id=$1 RETURNING *", [order.order_id])).rows[0];
    await client.query('INSERT INTO order_activity(order_activity_order_id,comment,customer_notified) VALUES($1,$2,FALSE)', [order.order_id, `Actual ${channel === 'paypal' ? 'PayPal' : 'bank'} receipt manually verified: ${denomination} ${amount}; reference ${reference}. USD merchandise payment recorded. Shipping remains deferred; shipment status unchanged.`]);
    return { quote: publicQuote(updated), paymentUrl: customerUrl(uuid) };
  });
}
export { publicQuote, getOrderQuote, customerUrl, confirmQuote, recordReceipt, linkPaypalInvoice, openPaypalInvoice, beforeCancelOrderPayment };
