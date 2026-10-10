export function applicationOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 2000) throw new Error('Payment application is not configured');
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid payment application origin');
  return origin.origin;
}

export async function requestPaymentEntry({ backendOrigin, orderId, fullyAuthenticated, getSessionToken, fetchImpl = fetch, now = Date.now, signal } = {}) {
  if (fullyAuthenticated !== true || !/^gid:\/\/shopify\/Order\/\d+$/.test(orderId || '')) return null;
  const origin = applicationOrigin(backendOrigin);
  const token = await getSessionToken();
  if (typeof token !== 'string' || !token || token.length > 8192 || /[\r\n]/.test(token)) throw new Error('A signed customer session is required');
  const response = await fetchImpl(`${origin}/api/shopify/payment-access`, {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId })
  });
  // Do not surface private backend errors or payment details in the platform UI.
  if ([401, 403, 404, 409].includes(response.status)) return null;
  if (!response.ok) throw new Error('Payment details are temporarily unavailable');
  let envelope;
  try { envelope = await response.json(); }
  catch { throw new Error('Payment entry is invalid or expired'); }
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(envelope) || Object.keys(envelope).length !== 1 || !isObject(envelope.data) || Object.keys(envelope.data).length !== 3 || Object.keys(envelope.data).some(key => !['paymentUrl', 'expiresAt', 'quoteRevision'].includes(key))) throw new Error('Payment entry is invalid or expired');
  const result = envelope.data;
  if (!result || typeof result.paymentUrl !== 'string' || result.paymentUrl.length > 10000 || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now() + 5000 || result.expiresAt > now() + 300000 || !Number.isSafeInteger(result.quoteRevision) || result.quoteRevision < 1) throw new Error('Payment entry is invalid or expired');
  let url;
  try { url = new URL(result.paymentUrl); }
  catch { throw new Error('Payment entry destination is invalid'); }
  const access = url.searchParams.get('access');
  if (url.origin !== origin || url.pathname !== '/shopify/payment' || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 1 || !access || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(access)) throw new Error('Payment entry destination is invalid');
  return { paymentUrl: url.href, expiresAt: result.expiresAt, quoteRevision: result.quoteRevision };
}
