import { money } from './paymentValidation.js';

const INVOICE_ID = /^INV2(?:-[A-Z0-9]{4}){4}$/;

export function paypalInvoiceEnvironment() {
  const mode = process.env.SHUSHA_PAYPAL_ENV;
  if (mode === 'live') return mode;
  if (mode === 'sandbox' && process.env.DB_NAME !== 'shusha_v2_production' && process.env.NODE_ENV !== 'production') return mode;
  return null;
}

export function paypalInvoicesEnabled() {
  return process.env.SHUSHA_PAYPAL_INVOICES_ENABLED === '1' && !!paypalInvoiceEnvironment() &&
    !!process.env.PAYPAL_CLIENT_ID?.trim() && !!process.env.PAYPAL_SECRET?.trim() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SHUSHA_PAYPAL_MERCHANT_EMAIL || '');
}

export function invoiceReference(quote) {
  if (!quote || !Number.isSafeInteger(quote.revision) || quote.revision <= 0 ||
      typeof quote.reference !== 'string' || !quote.reference.trim()) throw new Error('A versioned order reference is required');
  return `${quote.reference}-R${quote.revision}`;
}

async function paypalJson(url, options) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (response.ok) return await response.json();
  } catch {
    // Provider bodies, headers and network errors may contain private information.
  }
  throw new Error('PayPal invoice verification is temporarily unavailable');
}

export async function getPaypalInvoice(invoiceId) {
  if (typeof invoiceId !== 'string' || !INVOICE_ID.test(invoiceId)) throw new Error('Invalid PayPal invoice ID');
  if (!paypalInvoicesEnabled()) throw new Error('PayPal invoice verification is unavailable');
  const base = paypalInvoiceEnvironment() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const auth = await paypalJson(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (auth?.token_type?.toLowerCase() !== 'bearer' || typeof auth.access_token !== 'string' || !/^\S+$/.test(auth.access_token)) {
    throw new Error('PayPal invoice authorization is unavailable');
  }
  const invoice = await paypalJson(`${base}/v2/invoicing/invoices/${invoiceId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${auth.access_token}`, Accept: 'application/json' }
  });
  if (invoice?.id !== invoiceId) throw new Error('PayPal returned a different invoice');
  verifyMerchant(invoice);
  return invoice;
}

function verifyMerchant(invoice) {
  if (!paypalInvoicesEnabled() || !INVOICE_ID.test(invoice?.id || '') ||
      typeof invoice?.invoicer?.email_address !== 'string' ||
      invoice.invoicer.email_address.toLowerCase() !== process.env.SHUSHA_PAYPAL_MERCHANT_EMAIL.toLowerCase()) {
    throw new Error('PayPal invoice merchant could not be verified');
  }
}

function isZero(amount, currency) {
  return amount?.currency_code === currency && typeof amount.value === 'string' && /^0(?:\.0{1,2})?$/.test(amount.value);
}

function noActivity(activity, totalField, currency) {
  if (activity === undefined) return true;
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return false;
  const { transactions } = activity;
  return (transactions === undefined || (Array.isArray(transactions) && transactions.length === 0)) &&
    (activity[totalField] === undefined || isZero(activity[totalField], currency));
}

function matchesAmount(amount, quote) {
  return amount?.currency_code === quote.currency && money(amount.value) === money(quote.amount);
}

function verifyQuote(invoice, quote) {
  verifyMerchant(invoice);
  if (invoice.detail?.reference !== invoiceReference(quote) || invoice.detail.currency_code !== quote.currency ||
      !matchesAmount(invoice.amount, quote)) throw new Error('PayPal invoice does not match this quote revision, currency and amount');
  const configuration = invoice.configuration;
  const allowTip = configuration?.allow_tip;
  const allowPartial = configuration?.partial_payment?.allow_partial_payment;
  const conditionalPrice = configuration?.has_conditional_rule;
  const paymentMethods = configuration?.payment_method_overrides;
  const shipping = invoice.amount.breakdown?.shipping?.amount;
  if ((allowTip !== undefined && allowTip !== false) || (allowPartial !== undefined && allowPartial !== false) ||
      (conditionalPrice !== undefined && conditionalPrice !== false) ||
      (paymentMethods !== undefined && !(Array.isArray(paymentMethods) && paymentMethods.length === 0)) ||
      (shipping !== undefined && !isZero(shipping, quote.currency)) ||
      (invoice.gratuity !== undefined && !isZero(invoice.gratuity, quote.currency)) ||
      !noActivity(invoice.refunds, 'refund_amount', quote.currency)) {
    throw new Error('Use a fixed merchandise invoice with standard payment methods, without shipping, tips, partial payments or refunds');
  }
}

export function verifyPayableInvoice(invoice, quote) {
  verifyQuote(invoice, quote);
  if (!['UNPAID', 'SENT', 'SHARED'].includes(invoice.status) || !matchesAmount(invoice.due_amount, quote) ||
      !noActivity(invoice.payments, 'paid_amount', quote.currency)) throw new Error('PayPal invoice is not payable in full');

  const origin = paypalInvoiceEnvironment() === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com';
  const compactId = invoice.id.slice(5).replaceAll('-', '');
  const recipientUrl = invoice.detail.metadata?.recipient_view_url;
  if (recipientUrl !== `${origin}/invoice/p/#${compactId}` && recipientUrl !== `${origin}/invoice/p/#${invoice.id}`) {
    throw new Error('PayPal returned an unrecognized buyer invoice link');
  }
  return recipientUrl;
}

export function verifyRetiredInvoice(invoice, expectedInvoiceId) {
  verifyMerchant(invoice);
  const currency = invoice.detail?.currency_code;
  if (invoice.id !== expectedInvoiceId || !['CANCELLED', 'AUTO_CANCELLED'].includes(invoice.status) ||
      typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ||
      !noActivity(invoice.payments, 'paid_amount', currency) || !noActivity(invoice.refunds, 'refund_amount', currency)) {
    throw new Error('The previous PayPal invoice must be cancelled without payments before continuing');
  }
  return true;
}

export function verifyPaidInvoice(invoice, quote, receiptReference) {
  verifyQuote(invoice, quote);
  const payments = invoice.payments;
  const transaction = payments?.transactions?.[0];
  if (invoice.status !== 'PAID' || !isZero(invoice.due_amount, quote.currency) || !matchesAmount(payments?.paid_amount, quote) ||
      !Array.isArray(payments.transactions) || payments.transactions.length !== 1 || transaction?.type !== 'PAYPAL' ||
      typeof transaction.payment_id !== 'string' || !transaction.payment_id || transaction.payment_id !== receiptReference ||
      !matchesAmount(transaction.amount, quote)) throw new Error('PayPal could not verify a single matching payment for this quote');
  return true;
}
