const SKU_PREFIX = 'SHUSHA-';
const LEGACY_SKU_PREFIX = 'FRED-SUUSHA-';
const MAX_PRICE_CENTS = 9999999999n;

function decimal(value, label, maxDecimals, maxWholeDigits = 8) {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? String(value) : value;
  if (typeof text !== 'string' ||
      !new RegExp(`^\\d{1,${maxWholeDigits}}(?:\\.\\d{1,${maxDecimals}})?$`).test(text)) {
    throw new Error(`${label} must be a non-negative decimal with at most ${maxDecimals} decimal places`);
  }
  const [whole, fraction = ''] = text.split('.');
  return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}

function normalizeRules(input = {}) {
  const enabled = input.enabled === undefined ? false : input.enabled;
  if (typeof enabled !== 'boolean') throw new Error('retailPricing.enabled must be boolean');
  const multiplier = input.multiplier === undefined ? '1.1' : input.multiplier;
  const factor = decimal(multiplier, 'retailPricing.multiplier', 6, 3);
  if (factor.numerator <= 0n || factor.numerator > 100n * factor.denominator) {
    throw new Error('retailPricing.multiplier must be greater than 0 and at most 100');
  }
  return Object.freeze({ enabled, multiplier: String(multiplier), factor });
}

function retailCents(sourcePrice, rules) {
  const source = decimal(sourcePrice, 'Supplier price', 4);
  if (source.numerator === 0n) return 0n;
  const numerator = source.numerator * rules.factor.numerator;
  const denominator = source.denominator * rules.factor.denominator;
  // Smallest n.99 >= the exact, unrounded source price * multiplier.
  const delta = numerator * 100n - 99n * denominator;
  const dollarDenominator = 100n * denominator;
  const dollars = delta <= 0n ? 0n : (delta + dollarDenominator - 1n) / dollarDenominator;
  const cents = dollars * 100n + 99n;
  if (cents > MAX_PRICE_CENTS) throw new Error('Retail price exceeds EverShop decimal(12,4) storage limit');
  return cents;
}

function applies(product, rules) {
  return rules.enabled && typeof product?.sku === 'string' && product.sku.startsWith(SKU_PREFIX);
}

function retailPrice(product, rules) {
  return applies(product, rules) ? Number(retailCents(product.price, rules)) / 100 : product.price;
}

function publicSku(sku) {
  // Historic cart/order snapshots stay unchanged in storage. Present only the
  // known managed source-style shape under its current brand to customers.
  if (typeof sku !== 'string' || !/^FRED-SUUSHA-L\d{3,8}(?:-V-[A-Za-z0-9._-]{1,80})?$/.test(sku)) return sku;
  return SKU_PREFIX + sku.slice(LEGACY_SKU_PREFIX.length);
}

function retailSql(rules) {
  if (!rules.enabled) return 'product.price';
  // Only validated integers enter SQL; user supplied price filters use bound parameters.
  const { numerator, denominator } = rules.factor;
  return `(CASE WHEN LEFT(product.sku, ${SKU_PREFIX.length}) = '${SKU_PREFIX}' AND product.price > 0 THEN ` +
    `(GREATEST(0::numeric, CEIL(product.price::numeric * ${numerator}::numeric / ${denominator}::numeric - 0.99)) + 0.99) ` +
    'ELSE product.price END)';
}

function priceFilterValue(value) {
  try {
    const parsed = decimal(value, 'Price filter', 4);
    return parsed.numerator > 0n ? String(value) : null;
  } catch (_) {
    return null;
  }
}

export { SKU_PREFIX, normalizeRules, retailCents, retailPrice, retailSql, priceFilterValue, publicSku };
