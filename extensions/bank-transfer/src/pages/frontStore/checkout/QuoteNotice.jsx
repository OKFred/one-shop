import React from 'react';
import PropTypes from 'prop-types';

export default function QuoteNotice({ setting }) {
  if (setting.bankTransferPaymentStatus !== 1) return null;
  return <p className="p-4 border rounded border-divider mb-4"><strong>Order request only.</strong> Shipping and final payable amount are confirmed by our team before payment. Shipping is not included in the provisional amount shown.</p>;
}
QuoteNotice.propTypes = { setting: PropTypes.shape({ bankTransferPaymentStatus: PropTypes.number }).isRequired };
export const layout = { areaId: 'checkoutFormBefore', sortOrder: 5 };
export const query = `query Query { setting { bankTransferPaymentStatus } }`;
