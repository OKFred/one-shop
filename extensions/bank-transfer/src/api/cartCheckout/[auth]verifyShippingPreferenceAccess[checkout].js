import { pool } from '@evershop/evershop/lib/postgres';
import { getConfig } from '@evershop/evershop/lib/util/getConfig';
import { isEnabled } from '../../services/settings.js';
import { createShippingPreferenceAccessMiddleware } from '../../services/shippingPreferenceAccess.js';

// The native cookie-name helper has no public package export. Read the same
// documented configuration through the public API instead of importing core.
export default createShippingPreferenceAccessMiddleware({
  pool,
  isEnabled,
  getSessionCookieName: () => getConfig('system.session.cookieName', 'sid')
});
