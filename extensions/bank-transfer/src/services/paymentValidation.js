
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{12}[1-5][0-9a-f]{3}[89ab][0-9a-f]{15})$/i;
function validateOrderUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid order reference');
  return value;
}
function money(value) {
  // Decimal strings and integer arithmetic avoid accepting exponent notation,
  // silently rounding a transfer amount, or comparing floating point values.
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) throw new Error('Amount must be a positive decimal with at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > 999999999999n) throw new Error('Amount must be positive and within the supported limit');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
function usdMoney(value) {
  const source = String(value);
  if (!/^\d+(?:\.\d{1,4})?$/.test(source)) throw new Error('Invalid native USD order total');
  const [whole, decimals = ''] = source.split('.');
  if (decimals.slice(2).replace(/0/g, '')) throw new Error('Order total requires a reviewed USD precision adjustment');
  return money(`${whole}.${decimals.slice(0, 2).padEnd(2, '0')}`);
}
function currency(value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new Error('Invalid payment currency');
  return value;
}
function receiptReference(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._/:\-]{2,119}$/.test(value.trim())) throw new Error('Enter the actual bank receipt reference (3–120 characters)');
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}
function openLink(value) {
  if (!value) return null;
  if (typeof value !== 'string') throw new Error('Invalid Wise open link');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'wise.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/pay\/business\/[A-Za-z0-9._~\-]+\/?$/.test(url.pathname)) throw new Error('Use an official Wise Business open link without query parameters');
  return url.toString();
}
function paymentLink(base, amount, denomination, reference) {
  const safeBase = openLink(base);
  if (!safeBase) return null;
  const url = new URL(safeBase);
  url.searchParams.set('amount', money(amount));
  url.searchParams.set('currency', currency(denomination));
  url.searchParams.set('description', reference);
  return url.toString();
}
export { validateOrderUuid, money, usdMoney, currency, receiptReference, openLink, paymentLink };
