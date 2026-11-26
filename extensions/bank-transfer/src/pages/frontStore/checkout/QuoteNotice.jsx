import React from 'react';
import PropTypes from 'prop-types';
import PaypalPaymentOption from '../../../components/PaypalPaymentOption.js';

export default function QuoteNotice({ setting }) {
  if (setting.bankTransferPaymentStatus !== 1) return null;
  return (
    <section className="p-4 border rounded border-divider mb-4 space-y-4">
      <p><strong>Order request only.</strong> Shipping and final payable amount are confirmed by our team before payment. Shipping is not included in the provisional amount shown.</p>
      <PaypalPaymentOption enabled={setting.bankTransferPaypalEnabled} />
    </section>
  );
}
QuoteNotice.propTypes = { setting: PropTypes.shape({ bankTransferPaymentStatus: PropTypes.number, bankTransferPaypalEnabled: PropTypes.bool }).isRequired };
export const layout = { areaId: 'checkoutFormBefore', sortOrder: 5 };
export const query = `query Query { setting { bankTransferPaymentStatus bankTransferPaypalEnabled } }`;
