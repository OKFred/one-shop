import React from 'react';
import PropTypes from 'prop-types';
import { BankTransferContacts, BankTransferDetails } from './BankTransferDetails.js';
import './BankTransferPaymentPanel.scss';
import BrandIcon from './BrandIcon.js';

export const paymentQuoteType = PropTypes.shape({
  status: PropTypes.string.isRequired,
  revision: PropTypes.number.isRequired,
  currency: PropTypes.string.isRequired,
  amount: PropTypes.string.isRequired,
  merchandiseUsd: PropTypes.string.isRequired,
  reference: PropTypes.string.isRequired,
  wisePaymentUrl: PropTypes.string,
  bankDetails: PropTypes.arrayOf(PropTypes.shape({
    label: PropTypes.string.isRequired,
    value: PropTypes.string.isRequired
  })),
  receiptConfirmedAt: PropTypes.string,
  shippingDeferred: PropTypes.bool
});

export default function BankTransferPaymentPanel({ quote = null, setting }) {
  if (!quote || !['confirmed', 'paid'].includes(quote.status)) {
    return <BankTransferDetails setting={setting} />;
  }
  const received = quote.status === 'paid';
  return (
    <div className="shusha-payment-panel">
      <div className={`shusha-payment-amount${received ? ' received' : ''}`}>
        <span>{received ? 'Payment received' : 'Confirmed amount to pay'}</span>
        <strong>{quote.currency} {quote.amount}</strong>
        <p>Merchandise amount: USD {quote.merchandiseUsd}</p>
        <p>Shipping is not included and will be arranged separately.</p>
      </div>
      {received ? (
        <p className="shusha-payment-status" role="status">
          Our team has verified your payment. We will contact you about shipping.
        </p>
      ) : (
        <>
          {quote.wisePaymentUrl && (
            <div className="shusha-wise-payment">
              <a className="button primary" href={quote.wisePaymentUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <BrandIcon brand="wise" />
                <span>Pay with Wise</span>
              </a>
              <p>Check that Wise shows <strong>{quote.currency} {quote.amount}</strong> and reference <strong>{quote.reference}</strong> before paying. Wise may allow these fields to be edited.</p>
            </div>
          )}
          {quote.bankDetails?.length > 0 && (
            <section className="shusha-bank-backup">
              <h3>{quote.wisePaymentUrl ? 'Or pay by bank transfer' : 'Pay by bank transfer'}</h3>
              <p>Send <strong>{quote.currency} {quote.amount}</strong> using the details below. Include your payment reference.</p>
              <dl>
                {quote.bankDetails.map(({ label, value }) => (
                  <div key={`${label}-${value}`}><dt>{label}</dt><dd>{value}</dd></div>
                ))}
                <div><dt>Payment reference</dt><dd>{quote.reference}</dd></div>
              </dl>
              <p>Your bank or Wise may charge a transfer fee. Check the amount the recipient will receive before confirming.</p>
            </section>
          )}
          <p className="shusha-payment-status">Your order stays unpaid until our team verifies that the confirmed amount has arrived. Opening Wise or returning to this page does not confirm payment.</p>
        </>
      )}
      <BankTransferContacts setting={setting} />
    </div>
  );
}

BankTransferPaymentPanel.propTypes = {
  quote: paymentQuoteType,
  setting: PropTypes.object.isRequired
};
