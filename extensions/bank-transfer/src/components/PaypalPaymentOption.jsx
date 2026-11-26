import React from 'react';
import PropTypes from 'prop-types';
import './PaypalPaymentOption.scss';

export default function PaypalPaymentOption({ enabled = false, quote = null }) {
  const descriptionId = React.useId();
  if (!enabled) {
    return (
      <div className="shusha-paypal-option">
        <button type="button" disabled aria-describedby={descriptionId}>PayPal · WIP</button>
        <p id={descriptionId}>PayPal payments are not available yet.</p>
      </div>
    );
  }
  if (!quote) return <p>If PayPal is available for your order, the payment link will appear after quote confirmation.</p>;
  if (!quote.paypalPaymentUrl) return <p>A PayPal invoice link is unavailable on this page.</p>;
  return (
    <div className="shusha-paypal-option">
      <a href={quote.paypalPaymentUrl} referrerPolicy="no-referrer">Pay with PayPal</a>
      <p>Order reference: <strong>{quote.reference}</strong> · <strong>{quote.currency} {quote.amount}</strong></p>
    </div>
  );
}

PaypalPaymentOption.propTypes = {
  enabled: PropTypes.bool,
  quote: PropTypes.shape({
    paypalPaymentUrl: PropTypes.string,
    reference: PropTypes.string.isRequired,
    currency: PropTypes.string.isRequired,
    amount: PropTypes.string.isRequired
  })
};
