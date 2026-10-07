import React from 'react';
import PropTypes from 'prop-types';
import BankTransferPaymentPanel, { paymentQuoteType } from '../../../components/BankTransferPaymentPanel.js';

export default function BankTransferConfirmation({ order, setting }) {
  if (order?.paymentMethod !== 'banktransfer') return null;
  return (
    <section className="border rounded border-divider p-6 mb-8">
      <h2 className="mb-4">Order request #{order.orderNumber} received</h2>
      <p className="mb-4"><strong>{order.paymentStatus?.code === 'pending' ? 'Payment pending — no payment has been collected.' : `Payment status: ${order.paymentStatus?.name || order.paymentStatus?.code}`}</strong></p>
      <BankTransferPaymentPanel quote={order.bankTransferQuote} setting={setting} />
      {order.bankTransferPaymentUrl && <p className="mt-4"><a href={order.bankTransferPaymentUrl}>View your payment page</a></p>}
    </section>
  );
}

BankTransferConfirmation.propTypes = { order: PropTypes.shape({ paymentMethod: PropTypes.string, orderNumber: PropTypes.string, bankTransferQuote: paymentQuoteType, bankTransferPaymentUrl: PropTypes.string, paymentStatus: PropTypes.shape({ code: PropTypes.string, name: PropTypes.string }) }), setting: PropTypes.object.isRequired };
export const layout = { areaId: 'checkoutSuccessPageLeft', sortOrder: 5 };
export const query = `query Query {
  order(uuid: getContextValue('orderId')) {
    orderNumber paymentMethod paymentStatus { code name }
    bankTransferPaymentUrl
    bankTransferQuote { status revision currency amount merchandiseUsd reference wisePaymentUrl bankDetails { label value } receiptConfirmedAt shippingDeferred }
  }
  setting { bankTransferContactSriLanka bankTransferContactChina }
}`;
