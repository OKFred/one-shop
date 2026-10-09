import React from 'react';
import PropTypes from 'prop-types';
import { useCheckout, useCheckoutDispatch } from '@components/frontStore/checkout/CheckoutContext.js';
import { SHIPPING_PREFERENCE_MAX_LENGTH } from '../../../services/shippingPreferenceValidation.js';

export default function ShippingPreference({ setting, myCart }) {
  const { checkoutData, loading } = useCheckout();
  const { updateCheckoutData } = useCheckoutDispatch();
  if (setting.bankTransferPaymentStatus !== 1) return null;
  const value = checkoutData.shushaShippingPreference !== undefined
    ? checkoutData.shushaShippingPreference ?? ''
    : myCart?.shushaShippingPreference ?? '';
  return (
    <div className="mt-4 rounded-lg border border-border p-4">
      <label htmlFor="shusha-shipping-preference" className="block font-semibold mb-2">Preferred courier <span className="font-normal text-muted-foreground">(optional)</span></label>
      <input
        id="shusha-shipping-preference"
        type="text"
        className="w-full rounded-md border border-input bg-transparent px-3 py-2"
        value={value}
        maxLength={SHIPPING_PREFERENCE_MAX_LENGTH}
        placeholder="Leave blank for SHUSHA's recommendation"
        aria-describedby="shusha-shipping-preference-help"
        autoComplete="off"
        disabled={loading}
        onChange={(event) => updateCheckoutData({ shushaShippingPreference: event.target.value })}
      />
      <p id="shusha-shipping-preference-help" className="text-sm text-muted-foreground mt-2">If you have a preferred courier, enter its name. Our team will confirm availability and shipping cost before payment.</p>
    </div>
  );
}
ShippingPreference.propTypes = {
  setting: PropTypes.shape({ bankTransferPaymentStatus: PropTypes.number }).isRequired,
  myCart: PropTypes.shape({ shushaShippingPreference: PropTypes.string })
};
export const layout = { areaId: 'checkoutShippingMethodsAfter', sortOrder: 10 };
export const query = `query Query { setting { bankTransferPaymentStatus } myCart { shushaShippingPreference } }`;
