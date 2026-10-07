import { addProcessor } from '@evershop/evershop/lib/util/registry';
import { getStoreCurrency } from '@evershop/evershop/setting/services';
import { getPricePrecision } from '@evershop/evershop/checkout/services';
import { select, sql, update } from '@evershop/postgres-query-builder';
import { hookBefore } from '@evershop/evershop/lib/util/hookable';
import { registerPricing } from './services/registerPricing.js';
import { getRules } from './services/runtime.js';

export default async () => {
  const rules = getRules();
  if (rules.enabled && getStoreCurrency() !== 'USD') {
    throw new Error('Retail pricing source values are USD; shop.currency must be USD');
  }
  if (rules.enabled && getPricePrecision() !== 2) {
    throw new Error('Retail pricing requires pricing.precision = 2');
  }
  if (rules.enabled) {
    // Fail before listening if a later query builder release changes clone semantics.
    const clonedSql = await select().from('product').select(sql('1'), 'shusha_retail_clone_probe').clone().sql();
    if (typeof clonedSql !== 'string' || clonedSql.includes('shusha_retail_clone_probe')) {
      throw new Error('Query builder clone behavior is incompatible with retail price sorting');
    }
  }
  addProcessor('configurationSchema', (schema) => {
    schema.properties = schema.properties || {};
    schema.properties.retailPricing = {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        multiplier: { anyOf: [{ type: 'number', exclusiveMinimum: 0, maximum: 100 }, { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,6})?$' }] }
      }
    };
    return schema;
  }, 100);
  registerPricing({ addProcessor, getRules, sql, hookBefore, update });
};
