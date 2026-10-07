import { SKU_PREFIX, retailPrice, retailSql, priceFilterValue } from './pricing.js';

function amountCents(value) {
  if (value === null || value === undefined) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function changedPriceError() {
  return new Error('Prices or cart contents have changed. Please refresh checkout and review the new total before ordering.');
}

function registerPricing({ addProcessor, getRules, sql, hookBefore, update }) {
  if (typeof hookBefore !== 'function' || typeof update !== 'function') {
    throw new Error('Retail pricing requires the native order hook and database updater');
  }
  addProcessor('cartItemProductLoaderFunction', (loadProduct) => {
    if (typeof loadProduct !== 'function') throw new Error('EverShop cart product loader is missing');
    return async (id) => {
      const product = await loadProduct(id);
      if (!product) return product;
      // Do not mutate the database row or the original loader's cached object.
      return { ...product, price: retailPrice(product, getRules()) };
    };
  }, 100);

  addProcessor('productCollectionFilters', function storefrontPriceFilters(filters) {
    const rules = getRules();
    if (this.isAdmin || !rules.enabled) return filters;
    const expression = retailSql(rules);
    return filters.map((filter) => {
      if (filter.key === 'min_price' || filter.key === 'max_price') {
        const comparison = filter.key === 'min_price' ? '>=' : '<=';
        const bindingName = `shusha_retail_${filter.key}`;
        return { ...filter, callback(query, operation, value, currentFilters) {
          const boundValue = priceFilterValue(value);
          if (boundValue === null) return;
          query.getWhere().addRaw('AND', `${expression} ${comparison} :${bindingName}::numeric`, {
            [bindingName]: boundValue
          });
          currentFilters.push({ key: filter.key, operation, value });
        } };
      }
      if (filter.key === 'ob') {
        return { ...filter, callback(query, operation, value, currentFilters) {
          if (value !== 'price') return filter.callback(query, operation, value, currentFilters);
          // v1.2.0 SelectQuery.clone deliberately omits select fields, preserving
          // ProductCollection's count/visibility aggregate queries.
          query.select('*').select(sql(expression), 'shusha_retail_sort_price');
          query.orderBy('shusha_retail_sort_price');
          currentFilters.push({ key: filter.key, operation, value });
        } };
      }
      return filter;
    });
  }, 100);

  hookBefore('saveOrder', async function preserveCheckoutAmount(cart, connection) {
    if (!getRules().enabled || !cart.getItems().some((item) => {
      const sku = item.getData('product_sku');
      return typeof sku === 'string' && sku.startsWith(SKU_PREFIX);
    })) return;
    // The native Stripe API reads the persisted cart total, while the native
    // order creator exports a freshly rebuilt cart. Keep the two snapshots
    // aligned in the order creator's transaction, and require review if a
    // scheduled supplier update changed the amount since checkout was shown.
    const result = await connection.query({
      text: 'SELECT grand_total, currency FROM cart WHERE cart_id = $1 FOR UPDATE',
      values: [cart.getData('cart_id')]
    });
    const prior = result.rows[0];
    const current = cart.exportData();
    if (!prior) throw new Error('Checkout cart snapshot was not found');
    const priorCents = amountCents(prior.grand_total);
    const currentCents = amountCents(current.grand_total);
    if (priorCents === null || currentCents === null ||
        priorCents !== currentCents || prior.currency !== current.currency) {
      throw changedPriceError();
    }
    const priorItems = await connection.query({
      text: 'SELECT uuid, qty, product_price, product_price_incl_tax, final_price, final_price_incl_tax FROM cart_item WHERE cart_id = $1 ORDER BY cart_item_id FOR UPDATE',
      values: [cart.getData('cart_id')]
    });
    const currentItems = current.items;
    const priorByUuid = new Map(priorItems.rows.map((item) => [item.uuid, item]));
    const priceFields = ['product_price', 'product_price_incl_tax', 'final_price', 'final_price_incl_tax'];
    if (!Array.isArray(currentItems) || currentItems.length !== priorItems.rows.length ||
        currentItems.some((item) => {
          const previous = priorByUuid.get(item.uuid);
          return !previous || Number(previous.qty) !== Number(item.qty) || priceFields.some((key) => {
            const before = amountCents(previous[key]);
            const after = amountCents(item[key]);
            return before === null || after === null || before !== after;
          });
        })) {
      throw changedPriceError();
    }
    await update('cart').given(current).where('cart_id', '=', cart.getData('cart_id')).execute(connection, false);
  }, 100);
}

export { registerPricing };
