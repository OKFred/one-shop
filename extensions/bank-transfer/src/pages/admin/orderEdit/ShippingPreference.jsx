import React from 'react';
import PropTypes from 'prop-types';
import { SHIPPING_PREFERENCE_DEFAULT_LABEL } from '../../../services/shippingPreferenceValidation.js';

export default function ShippingPreference({ order }) {
  if (!order || order.paymentMethod !== 'banktransfer' || order.noShippingRequired) return null;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="font-semibold">Preferred courier</p>
      <p>{order.shushaShippingPreference || SHIPPING_PREFERENCE_DEFAULT_LABEL}</p>
      <p className="text-sm text-muted-foreground mt-1">Customer preference only. Confirm courier availability and shipping cost before arranging delivery.</p>
    </div>
  );
}
ShippingPreference.propTypes = { order: PropTypes.shape({ paymentMethod: PropTypes.string, noShippingRequired: PropTypes.bool, shushaShippingPreference: PropTypes.string }) };
export const layout = { areaId: 'orderEditCustomerNotes', sortOrder: 20 };
export const query = `query Query { order(uuid: getContextValue("orderId")) { paymentMethod noShippingRequired shushaShippingPreference } }`;
