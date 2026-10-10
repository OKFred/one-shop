import { AsyncLocalStorage } from 'node:async_hooks';

// A session advisory lock survives autocommit: operation intent is durable
// before calling Shopify, rather than vanishing with a process/connection loss.
export function createRepositories(pool) {
  const context = new AsyncLocalStorage();
  const db = () => context.getStore() || pool;
  async function withLock(key, work) {
    const existing = context.getStore();
    if (existing) {
      await existing.query('SELECT pg_advisory_lock(hashtext($1))', [`shusha-shopify:${key}`]);
      try { return await work(); }
      finally { await existing.query('SELECT pg_advisory_unlock(hashtext($1))', [`shusha-shopify:${key}`]); }
    }
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`shusha-shopify:${key}`]);
      return await context.run(client, work);
    } finally {
      let cleanupError;
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`shusha-shopify:${key}`]); }
      catch (error) { cleanupError = error; throw error; }
      finally { client.release(cleanupError); }
    }
  }
  const tokens = {
    withLock,
    async get(shop) { return (await db().query('SELECT envelope,revision,updated_at AS "updatedAt" FROM shusha_bridge_token WHERE shop=$1', [shop])).rows[0] || null; },
    async save(shop, record) {
      return (await db().query(`INSERT INTO shusha_bridge_token(shop,envelope) VALUES($1,$2)
        ON CONFLICT(shop) DO UPDATE SET envelope=EXCLUDED.envelope,revision=shusha_bridge_token.revision+1,updated_at=now()
        RETURNING revision`, [shop, record.envelope])).rows[0];
    },
    async remove(shop) { await db().query('DELETE FROM shusha_bridge_token WHERE shop=$1', [shop]); }
  };
  async function get(kind, key) { return (await db().query('SELECT record FROM shusha_bridge_mapping WHERE kind=$1 AND source_key=$2', [kind, String(key)])).rows[0]?.record || null; }
  async function save(kind, key, record) {
    await db().query(`INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES($1,$2,$3)
      ON CONFLICT(kind,source_key) DO UPDATE SET record=EXCLUDED.record,updated_at=now()`, [kind, String(key), JSON.stringify(record)]);
  }
  const mappings = { withLock,
    getProduct: key => get('product', key), saveProduct: (key, row) => save('product', key, row),
    getMedia: key => get('media', key), saveMedia: (key, row) => save('media', key, row),
    getOperation: key => get('operation', key), saveOperation: (key, row) => save('operation', key, row),
    get: key => get('content', key), set: (key, row) => save('content', key, row), put: (key, row) => save('content', key, row)
  };
  async function consumeNonce(nonce, expiresAt) {
    const result = await pool.query('INSERT INTO shusha_bridge_oauth_nonce(nonce,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING nonce', [nonce, new Date(expiresAt)]);
    return result.rowCount === 1;
  }
  return {tokens,mappings,consumeNonce};
}
