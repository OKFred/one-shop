import React from 'react';
import PropTypes from 'prop-types';
import BankTransferPaymentPanel, { paymentQuoteType } from '../../../components/BankTransferPaymentPanel.js';

export default function BankTransferConfirmation({ order, setting }) {
  if (order?.paymentMethod !== 'banktransfer') return null;
  const open = ['pending', 'paid'].includes(order.paymentStatus?.code) && !['canceled', 'cancelled', 'closed'].includes(order.status?.code) && !['canceled', 'cancelled'].includes(order.shipmentStatus?.code);
  return (
    <section className="border rounded border-divider p-6 mb-8">
      <h2 className="mb-4">Order request #{order.orderNumber} received</h2>
      <p className="mb-4"><strong>{order.paymentStatus?.code === 'pending' ? 'Payment receipt has not yet been confirmed.' : `Payment status: ${order.paymentStatus?.name || order.paymentStatus?.code}`}</strong></p>
      {open && <BankTransferPaymentPanel quote={order.bankTransferQuote} setting={setting} paid={order.paymentStatus?.code === 'paid'} />}
      {open && order.bankTransferPaymentUrl && <p className="mt-4"><a href={order.bankTransferPaymentUrl}>View your payment page</a></p>}
    </section>
  );
}

BankTransferConfirmation.propTypes = { order: PropTypes.shape({ paymentMethod: PropTypes.string, orderNumber: PropTypes.string, bankTransferQuote: paymentQuoteType, bankTransferPaymentUrl: PropTypes.string, paymentStatus: PropTypes.shape({ code: PropTypes.string, name: PropTypes.string }), status: PropTypes.shape({ code: PropTypes.string }), shipmentStatus: PropTypes.shape({ code: PropTypes.string }) }), setting: PropTypes.object.isRequired };
export const layout = { areaId: 'checkoutSuccessPageLeft', sortOrder: 5 };
export const query = `query Query {
  order(uuid: getContextValue('orderId')) {
    orderNumber paymentMethod paymentStatus { code name } status { code } shipmentStatus { code }
    bankTransferPaymentUrl
    bankTransferQuote { status revision currency amount merchandiseUsd reference wisePaymentUrl paypalPaymentUrl bankDetails { label value } receiptConfirmedAt shippingDeferred }
  }
  setting { bankTransferPaypalEnabled bankTransferContactSriLanka bankTransferContactChina }
}`;
