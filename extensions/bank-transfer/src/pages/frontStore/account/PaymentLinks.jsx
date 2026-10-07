import React from 'react';
import BrandIcon from '../../../components/BrandIcon.js';

export default function PaymentLinks({ payments = [] }) {
  if (!payments.length) return null;
  return (
    <section className="account mx-auto max-w-2xl pb-10">
      <h2 className="h5 mb-4">Order payments</h2>
      <p className="mb-4">View your confirmed Wise and bank transfer instructions. If payment is pending confirmation, please contact SHUSHA first.</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {payments.map((payment) => <li key={payment.bankTransferPaymentUrl} className="p-4 flex flex-wrap items-center justify-between gap-3"><span>Order #{payment.orderNumber} — {payment.bankTransferQuote?.status === 'paid' ? 'Payment received' : payment.bankTransferQuote ? 'Ready to pay' : 'Awaiting confirmation'}</span><a href={payment.bankTransferPaymentUrl} className="inline-flex items-center gap-2"><BrandIcon brand="wise" /><span>View payment instructions</span></a></li>)}
      </ul>
    </section>
  );
}

export const layout = { areaId: 'content', sortOrder: 20 };
export const query = `query Query { payments: bankTransferCustomerPayments { orderNumber bankTransferPaymentUrl bankTransferQuote { status } } }`;
