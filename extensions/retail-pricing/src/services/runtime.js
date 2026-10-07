import { getConfig } from '@evershop/evershop/lib/util/getConfig';
import { normalizeRules } from './pricing.js';

function getRules() {
  return normalizeRules(getConfig('retailPricing', {}));
}

export { getRules };
