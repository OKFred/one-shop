import React from 'react';
import BankTransferPaymentPanel from '../../../components/BankTransferPaymentPanel.js';

export default function OrderPayment({ order = null, setting }) {
  if (!order) return null;
  return <section className="account mx-auto max-w-2xl pb-10"><h2 className="h5 mb-4">Order payment</h2><BankTransferPaymentPanel quote={order.bankTransferQuote} setting={setting} /><p className="mt-4"><a href={order.bankTransferPaymentUrl}>View your payment page</a></p></section>;
}
export const layout = { areaId: 'content', sortOrder: 20 };
export const query = `query Query {
  order: bankTransferCustomerPaymentOrder(uuid: getContextValue("orderUuid")) { bankTransferPaymentUrl bankTransferQuote { status revision currency amount merchandiseUsd reference wisePaymentUrl bankDetails { label value } receiptConfirmedAt shippingDeferred } }
  setting { bankTransferContactSriLanka bankTransferContactChina }
}`;
