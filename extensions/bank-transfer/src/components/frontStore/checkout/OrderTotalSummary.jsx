import React from 'react';
import { OrderTotalSummary as CoreOrderTotalSummary, Subtotal, Discount, Tax } from '@evershop/evershop/components/frontStore/checkout/OrderTotalSummary';
import { useAppState } from '@components/common/context/app.js';

export function OrderTotalSummary(props) {
  const { config: { tax: { priceIncludingTax } } } = useAppState();
  if (props.shippingMethod !== 'Shipping quotation pending') return <CoreOrderTotalSummary {...props} />;
  return <div className="order__total__summary text-sm">
    <Subtotal subTotal={props.subTotal} />
    <Discount discountAmount={props.discountAmount} coupon={props.coupon} />
    <div className="flex justify-between gap-7 py-2"><span>Shipping</span><span>To be confirmed</span></div>
    <Tax amount={props.taxAmount} showPriceIncludingTax={priceIncludingTax} />
    <div className="flex justify-between gap-7 py-2 font-semibold"><span>Merchandise total</span><span>{props.total}</span></div>
    <p className="text-muted-foreground">Shipping is excluded and will be arranged separately.</p>
  </div>;
}

export { Subtotal, Discount, Shipping, Tax, Total } from '@evershop/evershop/components/frontStore/checkout/OrderTotalSummary';
