// Additive bridge data only. Native product, order and payment data is untouched.
export default async (connection) => {
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_token (
    shop text PRIMARY KEY, envelope text NOT NULL, revision integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now())`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_mapping (
    kind text NOT NULL, source_key text NOT NULL, record jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,source_key))`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_oauth_nonce (
    nonce text PRIMARY KEY, expires_at timestamptz NOT NULL)`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_inbox (
    delivery_id text PRIMARY KEY, shop text NOT NULL, topic text NOT NULL,
    payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0, received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz, last_error text)`);
};
