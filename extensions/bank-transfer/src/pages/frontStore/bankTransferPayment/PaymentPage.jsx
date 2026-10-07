import React from 'react';
import PropTypes from 'prop-types';
import BankTransferPaymentPanel, { paymentQuoteType } from '../../../components/BankTransferPaymentPanel.js';
import './PaymentPage.scss';

export default function PaymentPage({ order = null, setting }) {
  return (
    <main className="page-width shusha-order-payment">
      <h1>{order?.paymentMethod === 'banktransfer' ? `Order #${order.orderNumber}` : 'Order payment'}</h1>
      {order?.paymentMethod === 'banktransfer' ? (
        <BankTransferPaymentPanel quote={order.bankTransferQuote} setting={setting} />
      ) : (
        <p>Payment instructions are unavailable. Please contact SHUSHA for help with your order.</p>
      )}
    </main>
  );
}

PaymentPage.propTypes = {
  order: PropTypes.shape({
    orderNumber: PropTypes.string.isRequired,
    paymentMethod: PropTypes.string,
    bankTransferQuote: paymentQuoteType
  }),
  setting: PropTypes.object.isRequired
};
export const layout = { areaId: 'content', sortOrder: 10 };
export const query = `query Query {
  order: bankTransferPaymentOrder {
    orderNumber paymentMethod
    bankTransferQuote { status revision currency amount merchandiseUsd reference wisePaymentUrl bankDetails { label value } receiptConfirmedAt shippingDeferred }
  }
  setting { bankTransferContactSriLanka bankTransferContactChina }
}`;
