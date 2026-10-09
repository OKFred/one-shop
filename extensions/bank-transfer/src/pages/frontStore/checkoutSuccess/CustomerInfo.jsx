import React from 'react';
import { AddressSummary } from '@components/common/customer/address/AddressSummary.js';
import { SHIPPING_PREFERENCE_DEFAULT_LABEL } from '../../../services/shippingPreferenceValidation.js';

// Replaces the native success message, which assumes an emailed receipt.
// SHUSHA order requests don't collect payment or send automatic messages.
export default function CustomerInfo({ order }) {
  if (!order) return null;
  const manual = order.paymentMethod === 'banktransfer';
  return <div className="checkout-success-customer-info">
    <div className="text-center"><h1 className="text-3xl font-semibold">{manual ? 'Thank you for your order request!' : 'Thank you for your order!'}</h1><p className="mt-2">Order #{order.orderNumber} has been received. {manual ? 'Our team will confirm availability and payment instructions.' : 'You can review its status in your account.'}</p></div>
    <div className="mt-8 rounded-lg border border-border p-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div><h3 className="mb-2 font-semibold">Contact information</h3><p>{order.customerFullName}</p><p>{order.customerEmail}</p></div>
      <div><h3 className="mb-2 font-semibold">Shipping address</h3>{order.noShippingRequired ? <p>No shipping required</p> : order.shippingAddress && <AddressSummary address={order.shippingAddress} />}</div>
      {manual && !order.noShippingRequired && <div><h3 className="mb-2 font-semibold">Preferred courier</h3><p>{order.shushaShippingPreference || SHIPPING_PREFERENCE_DEFAULT_LABEL}</p><p className="text-sm mt-1">Our team will confirm the courier and shipping cost.</p></div>}
      <div><h3 className="mb-2 font-semibold">Payment method</h3><p>{order.paymentMethodName}</p></div>
      {order.billingAddress && <div><h3 className="mb-2 font-semibold">Billing address</h3><AddressSummary address={order.billingAddress} /></div>}
    </div>
  </div>;
}

export const layout = { areaId: 'checkoutSuccessPageLeft', sortOrder: 10 };
export const query = `query Query { order(uuid: getContextValue("orderId")) {
  orderNumber customerFullName customerEmail paymentMethod paymentMethodName noShippingRequired shushaShippingPreference
  shippingAddress { fullName postcode telephone country { name code } province { name code } city address1 address2 }
  billingAddress { fullName postcode telephone country { name code } province { name code } city address1 address2 }
} }`;
