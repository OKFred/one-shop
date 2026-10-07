import React from 'react';
import PaymentLinks from '../account/PaymentLinks.js';
export default function OrderListPaymentLinks(props) { return <PaymentLinks {...props} />; }
export const layout = { areaId: 'content', sortOrder: 20 };
export const query = `query Query { payments: bankTransferCustomerPayments { orderNumber bankTransferPaymentUrl bankTransferQuote { status } } }`;
