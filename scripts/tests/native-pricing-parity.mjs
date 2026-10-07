// Run after compiling the pinned native core and extensions. No DB/network calls.
import assert from 'node:assert/strict';

process.env.ALLOW_CONFIG_MUTATIONS = 'true';
process.env.NODE_CONFIG = JSON.stringify({
  retailPricing: { enabled: true, multiplier: '1.1' },
  pricing: { precision: 2, tax: { price_including_tax: false, round_level: 'unit', precision: 2, rounding: 'round' } },
  shop: { currency: 'USD', language: 'en', timezone: 'Asia/Shanghai' }
});

const [{ select, sql, update }, { registerCartItemBaseFields }, { registerPricing }, { normalizeRules }, { default: resolvers }, { pool }, { default: bootstrap }] = await Promise.all([
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
  const rules = normalizeRules({ enabled: true, multiplier: '1.1' });
  const processors = new Map();
  registerPricing({
    addProcessor: (name, fn) => processors.set(name, fn), hookBefore: (name, fn) => processors.set(`hook:${name}`, fn),
    getRules: () => rules, sql, update
  });
  const source = Object.freeze({ sku: 'SHUSHA-L1001', price: '4.0000', qty: 997 });
  const row = await processors.get('cartItemProductLoaderFunction')(async () => source)(1);
  const values = { qty: 3, tax_percent: 10, discount_amount: 0 };
  const fields = registerCartItemBaseFields([]);
  const context = { getProduct: async () => row, getData: key => values[key] };
  for (const key of ['product_price','product_price_incl_tax','final_price','final_price_incl_tax','line_total','line_total_incl_tax']) {
    values[key] = await fields.find(field => field.key === key).resolvers[0].call(context);
  }
  assert.equal(values.product_price, 4.99);
  assert.equal(values.final_price, 4.99);
  assert.equal(Math.round(values.line_total * 100), 1497);
  assert.equal(values.product_price_incl_tax, 5.49);
  assert.equal(source.price, '4.0000'); assert.equal(source.qty, 997);
  assert.deepEqual(resolvers.Product.price(source, {}, {}), { regular: 4.99, special: 4.99 });
  assert.deepEqual(resolvers.Product.price(source, {}, { customer: { id: 1 } }), { regular: 4.99, special: 4.99 });
  assert.deepEqual(resolvers.Product.price(source, {}, { user: { id: 1 } }), { regular: 4, special: 4 });
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
  console.log(JSON.stringify({ status: 'passed', nativeVersion: '2.2.1', sourceUsd: 4, adminUsd: 4, retailUsd: 4.99, nativeLineUsd: 14.97, originalQty: 997, historicalAmountsPreserved: true }));
} finally { await pool.end(); }
