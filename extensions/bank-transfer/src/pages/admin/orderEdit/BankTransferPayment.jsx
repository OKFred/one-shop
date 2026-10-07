import React from 'react';
import PropTypes from 'prop-types';
import axios from 'axios';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@components/common/ui/Card.js';
import { paymentQuoteType } from '../../../components/BankTransferPaymentPanel.js';
import './BankTransferPayment.scss';

const validAmount = (amount) => /^\d+(?:\.\d{1,2})?$/.test(amount) && Number(amount) > 0;

export default function BankTransferPayment({ order = null, receivingConfig = null, confirmQuoteAPI, recordReceiptAPI }) {
  const quote = order?.bankTransferQuote;
  const currencies = receivingConfig?.currencies || [];
  const [currency, setCurrency] = React.useState(quote?.currency || currencies[0] || 'GBP');
  const [amount, setAmount] = React.useState(quote?.amount || '');
  const [receiptCurrency, setReceiptCurrency] = React.useState(quote?.currency || '');
  const [receiptAmount, setReceiptAmount] = React.useState('');
  const [receiptReference, setReceiptReference] = React.useState('');
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
  const canRecord = quote?.status === 'confirmed' && /^[A-Z]{3}$/.test(receiptCurrency) && validAmount(receiptAmount) && receiptReference.trim().length >= 3 && receivedConfirmed && !pendingAction;
  const inactive = ['canceled', 'cancelled'].includes(order.status?.code);

  return (
    <Card>
      <CardHeader><CardTitle>Wise / bank transfer payment</CardTitle></CardHeader>
      <CardContent>
      <div className="shusha-admin-payment">
        <p>Merchandise amount: <strong>{order.currency} {Number(order.grandTotal.value).toFixed(2)}</strong>. Shipping remains pending and is excluded from this payment.</p>
        {quote && <p>Confirmed payment: <strong>{quote.currency} {quote.amount}</strong> · Reference: <strong>{quote.reference}</strong></p>}
        {order.bankTransferPaymentUrl && <p><a href={order.bankTransferPaymentUrl} target="_blank" rel="noopener noreferrer">Open customer payment page</a><span className="shusha-admin-note">Share this link with the customer after confirming availability.</span></p>}
        {paid ? (
          <p className="shusha-admin-message">Payment received and verified{quote?.receiptConfirmedAt ? ` · ${quote.receiptConfirmedAt.replace('T', ' ').replace('Z', ' UTC')}` : ''}. Shipping still needs to be arranged separately.</p>
        ) : inactive ? (
          <p className="shusha-admin-message">This order is cancelled. Payment actions are unavailable.</p>
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
                {quote && <p className="shusha-admin-note">Updating this quote changes what the customer payment page shows. Confirm any new amount with the customer before asking them to pay.</p>}
                <button className="button primary" type="button" disabled={!canQuote} onClick={() => request(confirmQuoteAPI, { currency, amount, shippingDeferred: true, expectedQuoteRevision: quote?.revision || 0 }, 'quote')}>
                  <span>{pendingAction === 'quote' ? 'Saving…' : quote ? 'Update payment quote' : 'Confirm payment quote'}</span>
                </button>
              </section>
            )}
            {quote?.status === 'confirmed' && (
              <section>
                <h4>Register funds received</h4>
                <p>Check the actual completed receipt in Wise or your bank. Expected: <strong>{quote.currency} {quote.amount}</strong>. A customer screenshot or an opened payment link is not proof of receipt.</p>
                <div className="shusha-admin-fields">
                  <label htmlFor="shusha-receipt-currency">Actual received currency
                    <input id="shusha-receipt-currency" type="text" maxLength={3} autoComplete="off" value={receiptCurrency} onChange={(event) => setReceiptCurrency(event.target.value.toUpperCase().trim())} disabled={Boolean(pendingAction)} />
                  </label>
                  <label htmlFor="shusha-receipt-amount">Actual received amount
                    <input id="shusha-receipt-amount" type="text" inputMode="decimal" autoComplete="off" value={receiptAmount} onChange={(event) => setReceiptAmount(event.target.value.trim())} placeholder="0.00" disabled={Boolean(pendingAction)} />
                  </label>
                  <label className="shusha-admin-field-wide" htmlFor="shusha-receipt-reference">Wise / bank receipt ID
                    <input id="shusha-receipt-reference" type="text" autoComplete="off" value={receiptReference} onChange={(event) => setReceiptReference(event.target.value)} disabled={Boolean(pendingAction)} />
                  </label>
                </div>
                <label className="shusha-admin-check" htmlFor="shusha-receipt-confirmed">
                  <input id="shusha-receipt-confirmed" type="checkbox" checked={receivedConfirmed} onChange={(event) => setReceivedConfirmed(event.target.checked)} disabled={Boolean(pendingAction)} />
                  <span>I checked Wise or the bank and confirmed these funds have arrived for this order.</span>
                </label>
                <button className="button primary" type="button" disabled={!canRecord} onClick={() => request(recordReceiptAPI, { currency: receiptCurrency, amount: receiptAmount, receiptReference: receiptReference.trim(), receivedConfirmed: true, quoteRevision: quote.revision }, 'receipt')}>
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
  receivingConfig: PropTypes.shape({ ready: PropTypes.bool, currencies: PropTypes.arrayOf(PropTypes.string), openLinkReady: PropTypes.bool }),
  order: PropTypes.shape({
    uuid: PropTypes.string.isRequired,
    currency: PropTypes.string.isRequired,
    grandTotal: PropTypes.shape({ value: PropTypes.number.isRequired }).isRequired,
    paymentMethod: PropTypes.string,
    paymentStatus: PropTypes.shape({ code: PropTypes.string }),
    status: PropTypes.shape({ code: PropTypes.string }),
    bankTransferQuote: paymentQuoteType,
    bankTransferPaymentUrl: PropTypes.string
  })
};
export const layout = { areaId: 'orderPaymentActions', sortOrder: 15 };
export const query = `query Query {
  confirmQuoteAPI: url(routeId: "bankTransferConfirmQuote", params: [{key: "orderUuid", value: getContextValue("orderId")}])
  recordReceiptAPI: url(routeId: "bankTransferRecordReceipt", params: [{key: "orderUuid", value: getContextValue("orderId")}])
  receivingConfig: bankTransferReceivingConfig { ready currencies openLinkReady }
  order(uuid: getContextValue("orderId")) {
    uuid currency grandTotal { value } paymentMethod paymentStatus { code } status { code }
    bankTransferPaymentUrl
    bankTransferQuote { status revision currency amount merchandiseUsd reference wisePaymentUrl bankDetails { label value } receiptConfirmedAt shippingDeferred }
  }
}`;
