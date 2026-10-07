import React from 'react';
import Area from '@components/common/Area.js';
import { useCartState } from '@components/frontStore/cart/CartContext.js';
import { CartTotalSummary as CoreCartTotalSummary, DefaultCartSummary, Subtotal, Discount, Tax } from '@evershop/evershop/components/frontStore/cart/CartTotalSummary';

export function CartTotalSummary({ children } = {}) {
  const { data: cart } = useCartState();
  const manual = cart.availablePaymentMethods?.some((method) => method.code === 'banktransfer') || cart.shippingMethodName === 'Shipping quotation pending';
  if (children || !manual) return <CoreCartTotalSummary>{children}</CoreCartTotalSummary>;
  return <CoreCartTotalSummary>{(state) => <div className="cart__total__summary text-sm">
    <Area id="cartSummaryBeforeSubTotal" noOuter />
    <Subtotal subTotal={state.subTotal} loading={state.loading} />
    <Area id="cartSummaryAfterSubTotal" noOuter />
    <Discount discountAmount={state.discountAmount} coupon={state.coupon} loading={state.loading} />
    <Area id="cartSummaryAfterDiscount" noOuter />
    <div className="flex justify-between gap-7 py-2"><span>Shipping</span><span>To be confirmed</span></div>
    <Area id="cartSummaryAfterShipping" noOuter />
    <Tax amount={state.taxAmount} showPriceIncludingTax={state.showPriceIncludingTax} loading={state.loading} />
    <Area id="cartSummaryAfterTax" noOuter />
    <div className="flex justify-between gap-7 border-t border-border mt-3 pt-4 font-semibold"><span>Merchandise total</span><span>{state.total}</span></div>
    <p className="mt-2 text-muted-foreground">Shipping is excluded. Wait for confirmed payment instructions.</p>
    <Area id="cartSummaryAfterTotal" noOuter />
  </div>}</CoreCartTotalSummary>;
}

export { DefaultCartSummary, Subtotal, Discount, Shipping, Tax, Total } from '@evershop/evershop/components/frontStore/cart/CartTotalSummary';
