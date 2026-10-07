import { sql } from '@evershop/postgres-query-builder';
import { toPrice } from '@evershop/evershop/checkout/services';
import { getProductsByCategoryBaseQuery } from '@evershop/evershop/catalog/services';
import { getRules } from '../../../services/runtime.js';
import { retailPrice, retailSql, publicSku } from '../../../services/pricing.js';

export default {
  CartItem: {
    productSku(item, _, context = {}) {
      return context.user ? item.productSku : publicSku(item.productSku);
    }
  },
  OrderItem: {
    productSku(item, _, context = {}) {
      return context.user ? item.productSku : publicSku(item.productSku);
    }
  },
  Product: {
    price(product, _, context = {}) {
      // EverShop reserves context.user for authenticated administrators;
      // storefront customer accounts use context.customer instead.
      const price = toPrice(context.user ? product.price : retailPrice(product, getRules()));
      return { regular: price, special: price };
    }
  },
  Category: {
    async priceRange(category, _, context) {
      const query = await getProductsByCategoryBaseQuery(category.categoryId, true);
      const rules = getRules();
      const expression = context.user ? 'product.price' : retailSql(rules);
      query.select(sql(`MIN(${expression})`), 'min').select(sql(`MAX(${expression})`), 'max');
      const result = await query.load(context.pool);
      return { min: Number(result.min || 0), minText: toPrice(result.min || 0, true), max: Number(result.max || 0), maxText: toPrice(result.max || 0, true) };
    }
  }
};
