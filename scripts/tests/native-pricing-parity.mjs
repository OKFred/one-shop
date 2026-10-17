// Run after compiling the pinned native core and extensions. No DB/network calls.
import assert from 'node:assert/strict';

process.env.ALLOW_CONFIG_MUTATIONS = 'true';
process.env.NODE_CONFIG = JSON.stringify({
  retailPricing: { enabled: true, multiplier: '1.5' },
  pricing: { precision: 2, tax: { price_including_tax: false, round_level: 'unit', precision: 2, rounding: 'round' } },
  shop: { currency: 'USD', language: 'en', timezone: 'Asia/Shanghai' }
});

const [{ select, sql, update }, { registerCartItemBaseFields }, { registerPricing }, { normalizeRules, retailCents }, { default: resolvers }, { pool }, { default: bootstrap }] = await Promise.all([
  import('@evershop/postgres-query-builder'),
  import('../../packages/evershop/dist/modules/checkout/services/cart/registerCartItemBaseFields.js'),
  import('../../extensions/retail-pricing/dist/services/registerPricing.js'),
  import('../../extensions/retail-pricing/dist/services/pricing.js'),
  import('../../extensions/retail-pricing/dist/graphql/types/RetailPrice/RetailPrice.resolvers.js'),
  import('@evershop/evershop/lib/postgres'),
  import('../../extensions/retail-pricing/dist/bootstrap.js')
]);

try {
  await bootstrap();
  const rules = normalizeRules({ enabled: true, multiplier: '1.5' });
  for (const [sourceUsd, expected] of [['3.32',499n],['4.40',699n],['0.6600',99n],['0.6601',199n],['6.6600',999n],['6.6601',1099n]]) {
    assert.equal(retailCents(sourceUsd, rules), expected);
  }
  const previousRules = normalizeRules({ enabled: true, multiplier: '1.1' });
  assert.equal(retailCents('4.40', previousRules), 499n);
  const processors = new Map();
  registerPricing({
    addProcessor: (name, fn) => processors.set(name, fn), hookBefore: (name, fn) => processors.set(`hook:${name}`, fn),
    getRules: () => rules, sql, update
  });
  const source = Object.freeze({ sku: 'SHUSHA-L1001', price: '4.4000', qty: 997 });
  const row = await processors.get('cartItemProductLoaderFunction')(async () => source)(1);
  const values = { qty: 3, tax_percent: 10, discount_amount: 0 };
  const fields = registerCartItemBaseFields([]);
  const context = { getProduct: async () => row, getData: key => values[key] };
  for (const key of ['product_price','product_price_incl_tax','final_price','final_price_incl_tax','line_total','line_total_incl_tax']) {
    values[key] = await fields.find(field => field.key === key).resolvers[0].call(context);
  }
  assert.equal(values.product_price, 6.99);
  assert.equal(values.final_price, 6.99);
  assert.equal(Math.round(values.line_total * 100), 2097);
  assert.equal(values.product_price_incl_tax, 7.69);
  assert.equal(source.price, '4.4000'); assert.equal(source.qty, 997);
  assert.deepEqual(resolvers.Product.price(source, {}, {}), { regular: 6.99, special: 6.99 });
  assert.deepEqual(resolvers.Product.price(source, {}, { customer: { id: 1 } }), { regular: 6.99, special: 6.99 });
  assert.deepEqual(resolvers.Product.price(source, {}, { user: { id: 1 } }), { regular: 4.4, special: 4.4 });
  const apiSource = Object.freeze({ sku: 'SHUSHA-L1002', price: '3.3200', qty: 998 });
  assert.equal((await processors.get('cartItemProductLoaderFunction')(async () => apiSource)(2)).price, 4.99);
  assert.deepEqual(resolvers.Product.price(apiSource, {}, {}), { regular: 4.99, special: 4.99 });
  assert.deepEqual(resolvers.Product.price(apiSource, {}, { user: { id: 1 } }), { regular: 3.32, special: 3.32 });
  assert.equal(apiSource.price, '3.3200'); assert.equal(apiSource.qty, 998);
  const history = Object.freeze({ productSku: 'FRED-SUUSHA-L1001', productPrice: '7.9900', lineTotal: '15.9800' });
  const before = JSON.stringify(history);
  assert.equal(resolvers.OrderItem.productSku(history, {}, {}), 'SHUSHA-L1001');
  assert.equal(resolvers.OrderItem.productSku(history, {}, { user: {} }), history.productSku);
  assert.equal(JSON.stringify(history), before);
  const query = select().from('product');
  const nativeFilters = ['min_price','max_price','ob'].map(key => ({ key, callback() { throw new Error('Source-price callback used'); } }));
  const mapped = processors.get('productCollectionFilters').call({ isAdmin: false }, nativeFilters);
  const current = [];
  mapped[0].callback(query, 'eq', '4.99', current);
  mapped[1].callback(query, 'eq', '5.99', current);
  mapped[2].callback(query, 'eq', 'price', current);
  const rendered = await query.sql();
  assert.match(rendered, /shusha_retail_sort_price/);
  assert.match(rendered, /shusha_retail_min_price::numeric/);
  assert.doesNotMatch(await query.clone().sql(), /AS "?shusha_retail_sort_price/);
  assert.match(rendered, /15::numeric \/ 10::numeric/);
  console.log(JSON.stringify({ status: 'passed', nativeVersion: '2.2.1', multiplier: '1.5', sourceUsd: 4.4, adminUsd: 4.4, retailUsd: 6.99, nativeLineUsd: 20.97, apiSourceUsdExample: 3.32, apiRetailUsdExample: 4.99, previousMultiplierExplicitlyConfigurable: true, originalQty: 997, historicalAmountsPreserved: true }));
} finally { await pool.end(); }
