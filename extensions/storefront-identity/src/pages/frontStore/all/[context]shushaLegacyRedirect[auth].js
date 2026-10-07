import { pool } from '@evershop/evershop/lib/postgres';
import { createLegacyRedirectHandler } from '../../../services/legacyRedirect.js';

// Every declared dependency must exist: native v2 sorting silently drops a
// middleware with a removed dependency (v1's detectCurrentCart no longer exists).
export default createLegacyRedirectHandler({
  query: (sql, parameters) => pool.query(sql, parameters)
});
