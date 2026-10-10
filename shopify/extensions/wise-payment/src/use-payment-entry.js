import { useEffect, useState } from 'preact/hooks';
import { requestPaymentEntry } from './payment-entry.js';

export function usePaymentEntry({ backendOrigin, orderId, fullyAuthenticated, customerId }) {
  const identity = JSON.stringify([backendOrigin, orderId, fullyAuthenticated, customerId]);
  const [state, setState] = useState({ kind: 'loading', entry: null, identity });
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false, expiryTimer;
    async function refresh() {
      setState({ kind: 'loading', entry: null, identity });
      if (!fullyAuthenticated || !backendOrigin || !orderId) { setState({ kind: 'unavailable', entry: null, identity }); return; }
      try {
        const entry = await requestPaymentEntry({ backendOrigin, orderId, fullyAuthenticated, signal: controller.signal, getSessionToken: () => shopify.sessionToken.get() });
        if (disposed) return;
        setState({ kind: entry ? 'ready' : 'unavailable', entry, identity });
        // Replace expired URLs with a fresh credential, never persist them.
        if (entry) expiryTimer = setTimeout(refresh, Math.max(1000, entry.expiresAt - Date.now() - 10000));
      } catch {
        if (!disposed) setState({ kind: 'error', entry: null, identity });
      }
    }
    refresh();
    return () => { disposed = true; controller.abort(); clearTimeout(expiryTimer); };
  }, [backendOrigin, orderId, fullyAuthenticated, customerId]);
  // Account/order changes must clear a previous bearer URL during render,
  // before the next effect gets a chance to refresh it.
  return state.identity === identity ? state : { kind: 'loading', entry: null };
}
