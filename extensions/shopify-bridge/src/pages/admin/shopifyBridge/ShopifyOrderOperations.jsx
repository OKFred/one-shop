import React, { useEffect, useRef, useState } from 'react';

const panelStyle = { border: '1px solid #d1d5db', borderRadius: 10, padding: 20, marginTop: 20 };
const fieldStyle = { display: 'block', width: '100%', border: '1px solid #9ca3af', borderRadius: 6, padding: '10px 12px', minHeight: 44, marginTop: 6 };
const actionStyle = { background: '#173e2d', color: '#fff', border: '1px solid #173e2d', borderRadius: 6, minHeight: 48, padding: '10px 18px', marginTop: 12 };
const rowsStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, margin: '12px 0' };
const exactMoney = (value, zero = false) => /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value) && (zero || Number(value) > 0);
const stableKey = () => `merchant_${globalThis.crypto.randomUUID().replaceAll('-', '_')}`;

export async function requestMerchantPayment(action, input, fetchImpl = fetch) {
  const response = await fetchImpl('/api/shopify/payment-operation', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input }) });
  const result = await response.json();
  if (!response.ok || result?.error || !result?.data) throw new Error('The operation could not be verified. Refresh the native order and review its original journal; do not submit another payment or shipment intent.');
  return result.data;
}

export async function requestMerchantOrderOperation(action, input, fetchImpl = fetch) {
  if (!['cancel', 'reconcile-cancel'].includes(action) || !/^gid:\/\/shopify\/Order\/\d+$/.test(input?.orderId || '') || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(input?.operationKey || '') ||
      action === 'cancel' && (input.merchantConfirmed !== true || !['CUSTOMER', 'INVENTORY', 'OTHER'].includes(input.reason))) throw new Error('An original order intent and explicit merchant cancellation confirmation are required.');
  const body = { action, orderId: input.orderId, operationKey: input.operationKey,
    ...(action === 'cancel' ? { reason: input.reason, merchantConfirmed: true } : {}) };
  const response = await fetchImpl('/api/shopify/orders/operation', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  // A submitted native mutation can have a verified UNKNOWN journal and a 409
  // response. Keep that original intent available for read-only reconciliation.
  if (result?.error || !['complete', 'pending', 'unknown'].includes(result?.data?.status) ||
      !response.ok && !(response.status === 409 && result.data.status === 'unknown' && result.data.requiresMerchantReview === true)) throw new Error('Cancellation could not be verified. Refresh native inspection and retain the original cancellation intent for reconciliation.');
  return result.data;
}

function Field({ id, label, value, onChange, disabled, inputMode, maxLength = 120 }) {
  return <label htmlFor={id}>{label}<input id={id} style={fieldStyle} type="text" autoComplete="off" inputMode={inputMode} maxLength={maxLength} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /></label>;
}
function Confirmation({ id, checked, onChange, disabled, children }) {
  return <label htmlFor={id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 12 }}><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} style={{ marginTop: 4 }} /><span>{children}</span></label>;
}
function Action({ disabled, children, onClick }) { return <button type="button" style={{ ...actionStyle, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }} disabled={disabled} onClick={onClick}>{children}</button>; }

export default function ShopifyOrderOperations({ orderId, writesEnabled = false, orderWritesEnabled = false, onChanged = () => {}, initialInspection = null }) {
  const [inspection, setInspection] = useState(initialInspection), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [shippingTitle, setShippingTitle] = useState('Confirmed manual shipping'), [shippingAmount, setShippingAmount] = useState(''), [availabilityConfirmed, setAvailabilityConfirmed] = useState(false);
  const [receiptAmount, setReceiptAmount] = useState(''), [receiptReference, setReceiptReference] = useState(''), [receiptConfirmed, setReceiptConfirmed] = useState(false);
  const [paidFundsConfirmed, setPaidFundsConfirmed] = useState(false), [markPaidConfirmed, setMarkPaidConfirmed] = useState(false);
  const [company, setCompany] = useState(''), [trackingNumber, setTrackingNumber] = useState(''), [trackingUrl, setTrackingUrl] = useState(''), [quantities, setQuantities] = useState({}), [shippedConfirmed, setShippedConfirmed] = useState(false);
  const [cancelReason, setCancelReason] = useState(''), [cancelConfirmed, setCancelConfirmed] = useState(false), [localCancellation, setLocalCancellation] = useState(null);
  const keys = useRef({}), inFlight = useRef(false), currentOrder = useRef(orderId);
  const quote = inspection?.quote;
  const nativeOrder = inspection?.nativeOrder;
  const inspectionMatches = nativeOrder?.id === orderId && currentOrder.current === orderId;
  const disabled = busy || !writesEnabled || !inspectionMatches;
  const orderDisabled = busy || !orderWritesEnabled || !inspectionMatches;
  const quotePending = quote?.pendingOperationKey;
  const paidPending = quote?.pendingPaymentOperationKey;
  const shipmentPending = quote?.pendingFulfillmentOperationKey;
  const cancellation = inspection?.cancellation || localCancellation;
  const cancelIntent = Boolean(cancellation);
  const cancelled = Boolean(nativeOrder?.cancelledAt || nativeOrder?.closed || cancellation?.status === 'complete');
  const financeBlocked = cancelled || cancelIntent;
  const prefix = `shopify-operations-${String(orderId || '').split('/').at(-1)}`;
  const fulfillmentOrders = nativeOrder?.fulfillmentOrders?.nodes || [];
  const availableLines = fulfillmentOrders.filter(order => ['OPEN', 'IN_PROGRESS'].includes(order.status)).flatMap(order => (order.lineItems?.nodes || []).filter(line => line.remainingQuantity > 0).map(line => ({ ...line, fulfillmentOrderId: order.id })));
  const selectedLines = availableLines.filter(line => /^(?:[1-9]\d*)$/.test(quantities[line.id] || '')).map(line => ({ fulfillmentOrderId: line.fulfillmentOrderId, fulfillmentOrderLineItemId: line.id, quantity: Number(quantities[line.id]) }));
  const validSelected = selectedLines.length > 0 && selectedLines.every(line => Number.isSafeInteger(line.quantity) && line.quantity <= availableLines.find(item => item.id === line.fulfillmentOrderLineItemId).remainingQuantity) && Object.values(quantities).every(value => value === '' || value === '0' || /^[1-9]\d*$/.test(value));
  const canQuote = !disabled && !financeBlocked && !quotePending && !paidPending && ['PENDING'].includes(nativeOrder?.displayFinancialStatus) && (!quote || ['inactive', 'confirmed'].includes(quote.status)) && availabilityConfirmed && shippingTitle.trim() && exactMoney(shippingAmount, true);
  const canReceipt = !disabled && !financeBlocked && !quotePending && !paidPending && ['confirmed', 'partial'].includes(quote?.status) && receiptConfirmed && exactMoney(receiptAmount) && /^[A-Za-z0-9][A-Za-z0-9 ._/:-]{2,119}$/.test(receiptReference.trim());
  const canPaid = !disabled && !financeBlocked && !paidPending && quote?.status === 'received' && paidFundsConfirmed && markPaidConfirmed;
  const canShip = !disabled && !financeBlocked && !shipmentPending && quote?.status === 'paid' && nativeOrder?.displayFinancialStatus === 'PAID' && shippedConfirmed && company.trim() && trackingNumber.trim() && validSelected && (!trackingUrl || /^https:\/\//.test(trackingUrl));
  const cancelEligible = !financeBlocked && nativeOrder?.displayFinancialStatus === 'PENDING' && !quotePending && !paidPending && !shipmentPending &&
    (!quote || ['inactive', 'confirmed'].includes(quote.status)) && Number(inspection?.receipts?.receivedAmount || quote?.receivedAmount || '0') === 0 && Number(inspection?.receipts?.count || '0') === 0 && !nativeOrder?.fulfillments?.length;
  const canCancel = !orderDisabled && cancelEligible && cancelConfirmed && ['CUSTOMER', 'INVENTORY', 'OTHER'].includes(cancelReason);

  useEffect(() => {
    currentOrder.current = orderId; keys.current = {}; setInspection(initialInspection); setError(''); setMessage('');
    setAvailabilityConfirmed(false); setReceiptConfirmed(false); setPaidFundsConfirmed(false); setMarkPaidConfirmed(false); setShippedConfirmed(false); setQuantities({});
    setCancelReason(''); setCancelConfirmed(false); setLocalCancellation(null);
    setShippingAmount(''); setReceiptAmount(''); setReceiptReference(''); setCompany(''); setTrackingNumber(''); setTrackingUrl('');
    let disposed = false;
    if (orderId) requestMerchantPayment('inspect', { orderId }).then(data => { if (!disposed) setInspection(data); }).catch(() => { if (!disposed) setError('Native order inspection is unavailable. Payment and shipment actions remain paused.'); });
    return () => { disposed = true; };
  }, [orderId]);

  async function refresh() {
    const forOrder = orderId; const data = await requestMerchantPayment('inspect', { orderId });
    if (currentOrder.current === forOrder) { setInspection(data); if (Object.prototype.hasOwnProperty.call(data, 'cancellation')) setLocalCancellation(data.cancellation); }
  }
  async function perform(action, input, { stable = false } = {}) {
    const orderOperation = ['cancel', 'reconcile-cancel'].includes(action);
    if (inFlight.current || !inspectionMatches || (orderOperation ? !orderWritesEnabled : !writesEnabled)) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage(''); const forOrder = orderId;
    if (stable) { keys.current[action] ||= stableKey(); input.operationKey = keys.current[action]; }
    if (action === 'cancel') setLocalCancellation({ status: 'unverified', operationKey: input.operationKey, reason: input.reason });
    try {
      const result = await (orderOperation ? requestMerchantOrderOperation : requestMerchantPayment)(action, input);
      if (currentOrder.current !== forOrder) return;
      const unresolved = result.unresolved || ['unknown', 'pending'].includes(result.status);
      if (stable && !unresolved) delete keys.current[action];
      if (orderOperation) setLocalCancellation({ status: result.status, operationKey: input.operationKey, reason: input.reason || cancellation?.reason });
      setAvailabilityConfirmed(false); setReceiptConfirmed(false); setPaidFundsConfirmed(false); setMarkPaidConfirmed(false); setShippedConfirmed(false);
      setCancelConfirmed(false);
      if (action === 'record-receipt') { setReceiptAmount(''); setReceiptReference(''); }
      setMessage(orderOperation && unresolved ? 'Cancellation is pending or unverified. Keep the original operation and use reconciliation; do not submit a new cancellation.' : unresolved ? 'The original native outcome is still unresolved. No native mutation was replayed.' : 'The operation was verified. No automatic customer message was sent.');
      try { await refresh(); } finally { await onChanged(); }
    } catch {
      if (currentOrder.current === forOrder) setError('The result is unverified. Refresh inspection and review the original journal before retrying. A different operation key cannot bypass an unresolved payment, shipment or cancellation.');
    } finally { inFlight.current = false; setBusy(false); }
  }
  if (!orderId) return null;

  return <section style={panelStyle} aria-label="Shopify manual payment, shipment and cancellation operations">
    <h2>Shipping quote, actual receipts and shipment</h2>
    <p>Native Shopify order money and status are checked again before each operation. All confirmations below start unchecked.</p>
    {!writesEnabled && <p role="status">Merchant writes are paused in the private runtime configuration.</p>}
    {!orderWritesEnabled && <p role="status">Order cancellation writes are paused in the private runtime configuration.</p>}
    <p>Native payment: <strong>{nativeOrder?.displayFinancialStatus || 'Inspection pending'}</strong> · Quote: <strong>{quote?.status || 'Not confirmed'}</strong>{quote && ` · Revision ${quote.revision} · USD ${quote.amount} · Received ${quote.receivedAmount || '0.00'} · Remaining ${quote.remainingAmount || quote.amount}`}</p>
    <Action disabled={busy} onClick={() => refresh().catch(() => setError('Native inspection could not be refreshed.'))}>Refresh native inspection</Action>
    {cancelled && <p>This native order is cancelled or closed. Payment and shipment writes are unavailable.</p>}
    {quotePending && <p role="alert">The shipping edit remains unresolved. Its original journal is {quotePending}. Payment entry stays inactive; inspect the native order before any recovery.</p>}

    <fieldset disabled={disabled || financeBlocked || Boolean(quotePending || paidPending)} style={{ marginTop: 20 }}><legend>1. Confirm availability and native shipping quote</legend>
      <p>Enter the manually agreed shipping amount in USD. Zero shipping is allowed only when that is your actual agreed quote. Shopify recalculates tax and the final amount.</p>
      <div style={rowsStyle}><Field id={`${prefix}-shipping-title`} label="Confirmed shipping description" value={shippingTitle} onChange={setShippingTitle} disabled={disabled} /><Field id={`${prefix}-shipping-amount`} label="Shipping amount (USD)" value={shippingAmount} onChange={setShippingAmount} inputMode="decimal" disabled={disabled} /></div>
      <Confirmation id={`${prefix}-availability`} checked={availabilityConfirmed} onChange={setAvailabilityConfirmed} disabled={disabled}>I checked availability and confirmed this shipping quote for this order.</Confirmation>
      <Action disabled={!canQuote} onClick={() => perform('confirm-quote', { orderId, expectedQuoteRevision: quote?.revision || 0, shippingTitle: shippingTitle.trim(), shippingAmount: shippingAmount.trim(), merchantAvailabilityConfirmed: availabilityConfirmed }, { stable: true })}>Confirm native shipping quote</Action>
    </fieldset>

    <fieldset disabled={disabled || financeBlocked || Boolean(paidPending)} style={{ marginTop: 20 }}><legend>2. Register independently verified incoming funds</legend>
      <p>Read the completed bank/Wise transaction yourself. A customer screenshot or an opened payment link does not establish receipt. Partial receipts stay in the central ledger; they do not mark Shopify paid.</p>
      <div style={rowsStyle}><Field id={`${prefix}-receipt-amount`} label="Actual received amount (USD)" value={receiptAmount} onChange={setReceiptAmount} inputMode="decimal" disabled={disabled} /><Field id={`${prefix}-receipt-reference`} label="Actual Wise/bank receipt reference" value={receiptReference} onChange={setReceiptReference} disabled={disabled} /></div>
      <Confirmation id={`${prefix}-receipt-confirmed`} checked={receiptConfirmed} onChange={setReceiptConfirmed} disabled={disabled}>I independently checked that these USD funds arrived for this order.</Confirmation>
      <Action disabled={!canReceipt} onClick={() => perform('record-receipt', { orderId, quoteRevision: quote.revision, currency: 'USD', amount: receiptAmount.trim(), receiptReference: receiptReference.trim(), receivedConfirmed: receiptConfirmed })}>Register actual receipt only</Action>
    </fieldset>

    <fieldset disabled={disabled || financeBlocked || Boolean(paidPending)} style={{ marginTop: 20 }}><legend>3. Separately register native paid status</legend>
      <p>This action becomes available after the global ledger covers the full current quote. It is limited to verified manual gateways; card authorizations and online gateways are rejected.</p>
      <Confirmation id={`${prefix}-paid-funds`} checked={paidFundsConfirmed} onChange={setPaidFundsConfirmed} disabled={disabled}>I checked that the actual receipts cover the full confirmed amount.</Confirmation>
      <Confirmation id={`${prefix}-mark-paid`} checked={markPaidConfirmed} onChange={setMarkPaidConfirmed} disabled={disabled}>I explicitly authorize registering this manual order as paid in Shopify.</Confirmation>
      <Action disabled={!canPaid} onClick={() => perform('mark-paid', { orderId, quoteRevision: quote.revision, receivedConfirmed: paidFundsConfirmed, markPaidConfirmed }, { stable: true })}>Register Shopify paid status</Action>
    </fieldset>
    {paidPending && <div><p role="alert">Paid registration is unresolved. Review original journal {paidPending}; reconciliation reads native status and does not replay the payment mutation.</p><Action disabled={disabled || financeBlocked} onClick={() => perform('reconcile-paid', { operationKey: paidPending })}>Reconcile original paid result</Action></div>}

    <fieldset disabled={disabled || financeBlocked || Boolean(shipmentPending)} style={{ marginTop: 20 }}><legend>4. Register an actual shipment</legend>
      <p>Select only quantities that have actually shipped. The native order must be paid; the backend verifies the current remaining quantities and merchant location.</p>
      {availableLines.length ? <div style={rowsStyle}>{availableLines.map(line => <label key={line.id} htmlFor={`${prefix}-${line.id.split('/').at(-1)}`}>Native item {line.lineItem?.id?.split('/').at(-1)} · unfulfilled {line.remainingQuantity}<input id={`${prefix}-${line.id.split('/').at(-1)}`} style={fieldStyle} type="number" min="0" max={line.remainingQuantity} step="1" inputMode="numeric" value={quantities[line.id] || ''} placeholder="0" onChange={event => setQuantities({ ...quantities, [line.id]: event.target.value })} /></label>)}</div> : <p>No selectable merchant fulfillment lines were returned by native inspection.</p>}
      <div style={rowsStyle}><Field id={`${prefix}-carrier`} label="Actual carrier" value={company} onChange={setCompany} disabled={disabled} maxLength={100} /><Field id={`${prefix}-tracking`} label="Actual tracking number" value={trackingNumber} onChange={setTrackingNumber} disabled={disabled} maxLength={100} /><Field id={`${prefix}-tracking-url`} label="HTTPS tracking URL (optional)" value={trackingUrl} onChange={setTrackingUrl} disabled={disabled} maxLength={2000} /></div>
      <Confirmation id={`${prefix}-shipped`} checked={shippedConfirmed} onChange={setShippedConfirmed} disabled={disabled}>I independently confirmed that the selected quantities have actually shipped with this tracking number.</Confirmation>
      <Action disabled={!canShip} onClick={() => perform('fulfill', { orderId, lines: selectedLines, trackingInfo: { company: company.trim(), number: trackingNumber.trim(), ...(trackingUrl.trim() ? { url: trackingUrl.trim() } : {}) }, actualShippedConfirmed: shippedConfirmed }, { stable: true })}>Register actual native shipment</Action>
    </fieldset>
    {shipmentPending && <div><p role="alert">Shipment registration is unresolved. Original journal {shipmentPending} must be reconciled against the actual native shipment.</p><Action disabled={disabled || financeBlocked} onClick={() => perform('reconcile-fulfillment', { operationKey: shipmentPending })}>Reconcile original shipment result</Action></div>}

    <fieldset disabled={orderDisabled || !cancelEligible} style={{ marginTop: 20 }}><legend>5. Explicitly cancel an untouched unpaid order</legend>
      <p>This flow is limited to unpaid manual orders with no actual receipts or shipments. Native cancellation is permanent. The backend verifies the original quantities and native restock allocation. Choose the actual reason and confirm the cancellation yourself.</p>
      <label htmlFor={`${prefix}-cancel-reason`}>Cancellation reason<select id={`${prefix}-cancel-reason`} style={fieldStyle} value={cancelReason} onChange={event => setCancelReason(event.target.value)} disabled={orderDisabled || !cancelEligible}><option value="">Choose a reason</option><option value="CUSTOMER">Customer request</option><option value="INVENTORY">Unavailable inventory</option><option value="OTHER">Other reviewed reason</option></select></label>
      <Confirmation id={`${prefix}-cancel-confirmed`} checked={cancelConfirmed} onChange={setCancelConfirmed} disabled={orderDisabled || !cancelEligible}>I explicitly authorize cancelling this unpaid order and have checked its current fulfillment allocation.</Confirmation>
      <Action disabled={!canCancel} onClick={() => perform('cancel', { orderId, reason: cancelReason, merchantConfirmed: cancelConfirmed }, { stable: true })}>Cancel confirmed unpaid order</Action>
    </fieldset>
    {cancellation && <div><p role={cancellation.status === 'complete' ? 'status' : 'alert'}>Cancellation {cancellation.status}. Original intent: {cancellation.operationKey}. Payment and shipment operations stay paused.</p>{cancellation.status !== 'complete' && <><p>Reconciliation reads the original native result. It does not replay cancellation.</p><Action disabled={orderDisabled || !cancellation.operationKey} onClick={() => perform('reconcile-cancel', { orderId, operationKey: cancellation.operationKey })}>Reconcile original cancellation result</Action></>}</div>}
    {message && <p role="status" style={{ marginTop: 16 }}>{message}</p>}{error && <p role="alert" style={{ marginTop: 16, color: '#b91c1c' }}>{error}</p>}
  </section>;
}
