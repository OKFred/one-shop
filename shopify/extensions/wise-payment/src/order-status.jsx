import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { usePaymentEntry } from './use-payment-entry.js';

export default () => render(<PaymentDetails />, document.body);

function PaymentDetails() {
  const fullyAuthenticated = shopify.authenticationState.value === 'fully_authenticated';
  const state = usePaymentEntry({ backendOrigin: shopify.settings.value.backend_origin, orderId: shopify.order.value?.id, fullyAuthenticated, customerId: shopify.authenticatedAccount.customer.value?.id });
  if (!fullyAuthenticated) return <s-stack direction="block" gap="base"><s-heading>Payment details</s-heading><s-paragraph>Sign in to review your confirmed order payment instructions.</s-paragraph><s-button variant="primary" inlineSize="fill" onClick={() => shopify.requireLogin()}>Sign in</s-button></s-stack>;
  return <s-stack direction="block" gap="base">
    <s-heading>Payment details</s-heading>
    {state.kind === 'ready' ? <><s-paragraph>Your order quote is confirmed. Review the remaining USD amount, Wise link and bank transfer instructions before paying.</s-paragraph><s-button variant="primary" inlineSize="fill" href={state.entry.paymentUrl} target="_blank">Pay with Wise or bank transfer</s-button></> : <s-paragraph>{state.kind === 'loading' ? 'Checking your confirmed quote…' : state.kind === 'error' ? 'Payment details are temporarily unavailable. Please refresh this page or contact support.' : 'No payable confirmed balance is available. Check your order status, or refresh/open a new entry if needed.'}</s-paragraph>}
  </s-stack>;
}
