import React from 'react';
import PropTypes from 'prop-types';
import axios from 'axios';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@components/common/ui/Card.js';
import { paymentQuoteType } from '../../../components/BankTransferPaymentPanel.js';
import './BankTransferPayment.scss';

const validAmount = (amount) => /^\d+(?:\.\d{1,2})?$/.test(amount) && Number(amount) > 0;

export default function BankTransferPayment({ order = null, receivingConfig = null, setting, confirmQuoteAPI, recordReceiptAPI, linkPaypalInvoiceAPI }) {
  const quote = order?.bankTransferQuote;
  const currencies = receivingConfig?.currencies || [];
  const [currency, setCurrency] = React.useState(quote?.currency || currencies[0] || 'GBP');
  const [amount, setAmount] = React.useState(quote?.amount || '');
  const [receiptCurrency, setReceiptCurrency] = React.useState(quote?.currency || '');
  const [receiptAmount, setReceiptAmount] = React.useState('');
  const [receiptReference, setReceiptReference] = React.useState('');
  const [receiptChannel, setReceiptChannel] = React.useState('bank');
  const [invoiceId, setInvoiceId] = React.useState('');
  const [receivedConfirmed, setReceivedConfirmed] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState(null);
  const [actionError, setActionError] = React.useState('');
  if (!order || order.paymentMethod !== 'banktransfer') return null;

  const request = async (url, body, action) => {
    if (pendingAction) return;
    setPendingAction(action);
    setActionError('');
    try {
      const response = await axios.post(url, body, { validateStatus: false });
      if (response.status >= 200 && response.status < 300 && !response.data?.error) {
        window.location.reload();
      } else {
        const message = response.data?.error?.message || 'The action was not accepted. Refresh this page before trying again.';
        setActionError(message);
        toast.error(message);
      }
    } catch {
      const message = 'The result could not be confirmed. Refresh this order before trying again.';
      setActionError(message);
      toast.error(message);
    } finally {
      setPendingAction(null);
    }
  };

  const paid = quote?.status === 'paid' || order.paymentStatus?.code === 'paid';
  const canQuote = receivingConfig?.ready && currencies.includes(currency) && validAmount(amount) && !pendingAction;
  const canRecord = quote?.status === 'confirmed' && (receiptChannel === 'bank' || quote.paypalInvoiceLinked) && /^[A-Z]{3}$/.test(receiptCurrency) && validAmount(receiptAmount) && receiptReference.trim().length >= 3 && receivedConfirmed && !pendingAction;
  const inactive = ['canceled', 'cancelled', 'closed'].includes(order.status?.code) || ['canceled', 'cancelled'].includes(order.shipmentStatus?.code) || order.paymentStatus?.code !== 'pending';
  const paypalReceipt = receiptChannel === 'paypal';

  return (
    <Card>
      <CardHeader><CardTitle>Order payment</CardTitle></CardHeader>
      <CardContent>
      <div className="shusha-admin-payment">
        <p>Merchandise amount: <strong>{order.currency} {Number(order.grandTotal.value).toFixed(2)}</strong>. Shipping remains pending and is excluded from this payment.</p>
        {quote && <p>Confirmed payment: <strong>{quote.currency} {quote.amount}</strong> · Reference: <strong>{quote.reference}</strong></p>}
        {order.bankTransferPaymentUrl && <p><a href={order.bankTransferPaymentUrl} target="_blank" rel="noopener noreferrer">Open customer payment page</a><span className="shusha-admin-note">Share this link with the customer after confirming availability.</span></p>}
        {paid ? (
          <p className="shusha-admin-message">Payment received and verified{quote?.receiptConfirmedAt ? ` · ${quote.receiptConfirmedAt.replace('T', ' ').replace('Z', ' UTC')}` : ''}. Shipping still needs to be arranged separately.</p>
        ) : inactive ? (
          <p className="shusha-admin-message">Payment actions are unavailable for this order.</p>
        ) : (
          <>
            {!receivingConfig?.ready ? (
              <p className="shusha-admin-message">Receiving details are not configured. Add verified receiving details to the server before confirming a payment amount.</p>
            ) : (
              <section>
                <h4>{quote ? 'Update confirmed payment amount' : 'Confirm payment amount'}</h4>
                <p>Confirm availability first. Enter the amount in the receiving currency that covers the merchandise amount above. Set the currency conversion manually; shipping will be handled separately.</p>
                <div className="shusha-admin-fields">
                  <label htmlFor="shusha-quote-currency">Receiving currency
                    <select id="shusha-quote-currency" value={currency} onChange={(event) => setCurrency(event.target.value)} disabled={Boolean(pendingAction)}>
                      {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
                    </select>
                  </label>
                  <label htmlFor="shusha-quote-amount">Amount to receive
                    <input id="shusha-quote-amount" type="text" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value.trim())} placeholder="0.00" disabled={Boolean(pendingAction)} />
                  </label>
                </div>
                {!receivingConfig.openLinkReady && <p className="shusha-admin-note">The customer page will show bank transfer instructions. A Wise button appears once the business open link is configured.</p>}
                {quote && <p className="shusha-admin-note">{quote.paypalInvoiceLinked ? 'Cancel the linked invoice in PayPal before changing this quote or replacing its invoice.' : 'Confirm any new amount with the customer before asking them to pay.'}</p>}
                <button className="button primary" type="button" disabled={!canQuote} onClick={() => request(confirmQuoteAPI, { currency, amount, shippingDeferred: true, expectedQuoteRevision: quote?.revision || 0 }, 'quote')}>
                  <span>{pendingAction === 'quote' ? 'Saving…' : quote ? 'Update payment quote' : 'Confirm payment quote'}</span>
                </button>
              </section>
            )}
            {quote?.status === 'confirmed' && (
              <section>
                <h4>PayPal invoice</h4>
                {quote.paypalInvoiceLinked ? (
                  <>
                    <p>Invoice linked to quote revision {quote.revision}. Reference: <strong>{quote.paypalInvoiceReference}</strong>.</p>
                    <button className="button" type="button" disabled={!setting.bankTransferPaypalEnabled || Boolean(pendingAction)} onClick={() => request(confirmQuoteAPI, { currency: quote.currency, amount: quote.amount, shippingDeferred: true, expectedQuoteRevision: quote.revision, renewPaypalInvoice: true }, 'renew')}>
                      <span>{pendingAction === 'renew' ? 'Checking cancellation…' : 'Reissue quote after cancelling PayPal invoice'}</span>
                    </button>
                  </>
                ) : setting.bankTransferPaypalEnabled ? (
                  <>
                    <p>In PayPal, prepare a payable invoice for <strong>{quote.currency} {quote.amount}</strong>. Set its reference to <strong>{quote.paypalInvoiceReference}</strong>. Enter the PayPal invoice ID below.</p>
                    <div className="shusha-admin-fields">
                      <label htmlFor="shusha-paypal-invoice-id">PayPal invoice ID
                        <input id="shusha-paypal-invoice-id" type="text" maxLength={64} value={invoiceId} autoComplete="off" placeholder="INV2-…" onChange={(event) => setInvoiceId(event.target.value.trim())} disabled={Boolean(pendingAction)} />
                      </label>
                    </div>
                    <button className="button" type="button" disabled={Boolean(pendingAction) || !invoiceId.startsWith('INV2-') || invoiceId.length <= 5} onClick={() => request(linkPaypalInvoiceAPI, { invoiceId, quoteRevision: quote.revision }, 'link')}>
                      <span>{pendingAction === 'link' ? 'Checking invoice…' : 'Verify and link invoice'}</span>
                    </button>
                  </>
                ) : (
                  <p>PayPal · WIP. Merchant invoice verification is unavailable.</p>
                )}
              </section>
            )}
            {quote?.status === 'confirmed' && (
              <section>
                <h4>Register funds received</h4>
                <p>Check the completed receipt in {paypalReceipt ? 'your PayPal merchant account' : 'Wise or your bank'}. Expected: <strong>{quote.currency} {quote.amount}</strong>.</p>
                <div className="shusha-admin-fields">
                  {quote.paypalInvoiceLinked && (
                    <label htmlFor="shusha-receipt-channel">Received through
                      <select id="shusha-receipt-channel" value={receiptChannel} onChange={(event) => { setReceiptChannel(event.target.value); setReceivedConfirmed(false); setReceiptReference(''); }} disabled={Boolean(pendingAction)}>
                        <option value="bank">Wise / bank transfer</option>
                        <option value="paypal">PayPal invoice</option>
                      </select>
                    </label>
                  )}
                  <label htmlFor="shusha-receipt-currency">Actual received currency
                    <input id="shusha-receipt-currency" type="text" maxLength={3} autoComplete="off" value={receiptCurrency} onChange={(event) => setReceiptCurrency(event.target.value.toUpperCase().trim())} disabled={Boolean(pendingAction)} />
                  </label>
                  <label htmlFor="shusha-receipt-amount">Actual received amount
                    <input id="shusha-receipt-amount" type="text" inputMode="decimal" autoComplete="off" value={receiptAmount} onChange={(event) => setReceiptAmount(event.target.value.trim())} placeholder="0.00" disabled={Boolean(pendingAction)} />
                  </label>
                  <label className="shusha-admin-field-wide" htmlFor="shusha-receipt-reference">{paypalReceipt ? 'PayPal transaction ID' : 'Wise / bank receipt ID'}
                    <input id="shusha-receipt-reference" type="text" autoComplete="off" value={receiptReference} onChange={(event) => setReceiptReference(event.target.value)} disabled={Boolean(pendingAction)} />
                  </label>
                </div>
                {quote.paypalInvoiceLinked && !paypalReceipt && <p className="shusha-admin-note">Cancel the unpaid invoice in PayPal before recording a Wise or bank receipt.</p>}
                <label className="shusha-admin-check" htmlFor="shusha-receipt-confirmed">
                  <input id="shusha-receipt-confirmed" type="checkbox" checked={receivedConfirmed} onChange={(event) => setReceivedConfirmed(event.target.checked)} disabled={Boolean(pendingAction)} />
                  <span>I checked {paypalReceipt ? 'PayPal' : 'Wise or the bank'} and confirmed these funds have arrived for this order.</span>
                </label>
                <button className="button primary" type="button" disabled={!canRecord} onClick={() => request(recordReceiptAPI, { currency: receiptCurrency, amount: receiptAmount, receiptReference: receiptReference.trim(), receiptChannel, receivedConfirmed: true, quoteRevision: quote.revision }, 'receipt')}>
                  <span>{pendingAction === 'receipt' ? 'Registering…' : 'Register receipt and mark paid'}</span>
                </button>
              </section>
            )}
          </>
        )}
        {actionError && <p className="shusha-admin-message critical" role="alert">{actionError}</p>}
      </div>
      </CardContent>
    </Card>
  );
}

BankTransferPayment.propTypes = {
  confirmQuoteAPI: PropTypes.string.isRequired,
  recordReceiptAPI: PropTypes.string.isRequired,
  linkPaypalInvoiceAPI: PropTypes.string.isRequired,
  setting: PropTypes.shape({ bankTransferPaypalEnabled: PropTypes.bool.isRequired }).isRequired,
  receivingConfig: PropTypes.shape({ ready: PropTypes.bool, currencies: PropTypes.arrayOf(PropTypes.string), openLinkReady: PropTypes.bool }),
  order: PropTypes.shape({
    uuid: PropTypes.string.isRequired,
    currency: PropTypes.string.isRequired,
    grandTotal: PropTypes.shape({ value: PropTypes.number.isRequired }).isRequired,
    paymentMethod: PropTypes.string,
    paymentStatus: PropTypes.shape({ code: PropTypes.string }),
    status: PropTypes.shape({ code: PropTypes.string }),
    shipmentStatus: PropTypes.shape({ code: PropTypes.string }),
    bankTransferQuote: paymentQuoteType,
    bankTransferPaymentUrl: PropTypes.string
  })
};
export const layout = { areaId: 'orderPaymentActions', sortOrder: 15 };
export const query = `query Query {
  confirmQuoteAPI: url(routeId: "bankTransferConfirmQuote", params: [{key: "orderUuid", value: getContextValue("orderId")}])
  recordReceiptAPI: url(routeId: "bankTransferRecordReceipt", params: [{key: "orderUuid", value: getContextValue("orderId")}])
  linkPaypalInvoiceAPI: url(routeId: "bankTransferLinkPaypalInvoice", params: [{key: "orderUuid", value: getContextValue("orderId")}])
  setting { bankTransferPaypalEnabled }
  receivingConfig: bankTransferReceivingConfig { ready currencies openLinkReady }
  order(uuid: getContextValue("orderId")) {
    uuid currency grandTotal { value } paymentMethod paymentStatus { code } status { code } shipmentStatus { code }
    bankTransferPaymentUrl
    bankTransferQuote { status revision currency amount merchandiseUsd reference paypalInvoiceLinked paypalInvoiceReference receiptConfirmedAt }
  }
}`;
