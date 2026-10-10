import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { usePaymentEntry } from './use-payment-entry.js';

export default () => render(<PaymentOrderAction />, document.body);

function PaymentOrderAction() {
  // This target has AuthenticatedAccount but no AuthenticationState API.
  // The signed session sub and native ownership are still checked server-side.
  const customerId = shopify.authenticatedAccount.customer.value?.id;
  const fullyAuthenticated = /^gid:\/\/shopify\/Customer\/\d+$/.test(customerId || '');
  const state = usePaymentEntry({ backendOrigin: shopify.settings.value.backend_origin, orderId: shopify.order.value?.id, fullyAuthenticated, customerId });
  if (state.kind !== 'ready') return null;
  // Shopify requires exactly one native button at the menu-item target.
  return <s-button href={state.entry.paymentUrl} target="_blank">Pay with Wise or bank transfer</s-button>;
}
