import { pool } from '@evershop/evershop/lib/postgres';
import { createLegacyRedirectHandler } from '../../../services/legacyRedirect.js';

export default createLegacyRedirectHandler({
  query: (sql, parameters) => pool.query(sql, parameters)
});
