import React, { useEffect } from 'react';
import { Button } from '@components/common/ui/Button.js';
import { toast } from 'sonner';
import { useCheckout, useCheckoutDispatch } from '@components/frontStore/checkout/CheckoutContext.js';
import { BankTransferDetails } from '../../../components/BankTransferDetails.js';

function RequestOrderButton() {
  const { checkout } = useCheckoutDispatch();
  const { loadingStates, orderPlaced } = useCheckout();
  const [uncertain, setUncertain] = React.useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (uncertain || loadingStates.placingOrder || orderPlaced) return;
    try { await checkout(); }
    catch (error) {
      // A lost response may hide a committed order. Don't automatically
      // retry. Native cart/checkout state is reloaded before another request.
      if (/fetch|network|timeout/i.test(error.message || '')) setUncertain(true);
      toast.error(error.message || 'The order result could not be confirmed. Refresh before trying again.');
    }
  };
  return <div><Button type="button" size="xl" className="w-full" onClick={submit} disabled={uncertain || loadingStates.placingOrder || orderPlaced}>{loadingStates.placingOrder ? 'Submitting order request…' : orderPlaced ? 'Order request received' : 'Submit order request'}</Button>{uncertain && <p role="alert">The order result could not be confirmed. Check your orders or contact SHUSHA before retrying.</p>}</div>;
}

export default function BankTransfer({ setting }) {
  const { checkoutSuccessUrl, orderPlaced, orderId, checkoutData } = useCheckout();
  const { registerPaymentComponent } = useCheckoutDispatch();
  useEffect(() => {
    if (orderPlaced && orderId && checkoutData.paymentMethod === 'banktransfer') window.location.assign(`${checkoutSuccessUrl}/${encodeURIComponent(orderId)}`);
  }, [orderPlaced, orderId, checkoutData.paymentMethod, checkoutSuccessUrl]);
  useEffect(() => {
    registerPaymentComponent('banktransfer', {
      nameRenderer: () => <strong>{setting.bankTransferDisplayName}</strong>,
      formRenderer: () => <BankTransferDetails setting={setting} />,
      checkoutButtonRenderer: RequestOrderButton
    });
  }, [registerPaymentComponent, setting]);
  return null;
}

export const layout = { areaId: 'checkoutFormAfter', sortOrder: 25 };
export const query = `query Query { setting { bankTransferDisplayName bankTransferContactSriLanka bankTransferContactChina } }`;
