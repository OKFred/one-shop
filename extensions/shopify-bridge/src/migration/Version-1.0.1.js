// Capacity is opened explicitly from a cutover snapshot, never defaulted to 999.
export default async connection => {
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_inventory (
    sku text PRIMARY KEY, product_id integer UNIQUE NOT NULL REFERENCES product(product_id),
    balance bigint NOT NULL, shopify_debt bigint NOT NULL DEFAULT 0 CHECK(shopify_debt>=0),
    frozen boolean NOT NULL DEFAULT false, freeze_reason text,
    opened_at timestamptz NOT NULL DEFAULT now())`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_ledger (
    id uuid PRIMARY KEY, business_key text UNIQUE NOT NULL,
    sku text NOT NULL REFERENCES shusha_bridge_inventory(sku), platform text NOT NULL,
    order_id text NOT NULL, line_id text NOT NULL, delta bigint NOT NULL,
    reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_order_line (
    platform text NOT NULL, order_id text NOT NULL, line_id text NOT NULL,
    sku text NOT NULL REFERENCES shusha_bridge_inventory(sku), consumed_qty bigint NOT NULL,
    released_qty bigint NOT NULL, legacy boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(platform,order_id,line_id))`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_outbox (
    id uuid PRIMARY KEY, intent_key text UNIQUE NOT NULL, kind text NOT NULL,
    aggregate_key text NOT NULL, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending',
    available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
    attempt_no integer NOT NULL DEFAULT 0, idempotency_key uuid,
    request_json jsonb, request_started_at timestamptz, last_error text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_orders (
    platform text NOT NULL, order_id text NOT NULL, number text NOT NULL,
    currency text NOT NULL, total numeric NOT NULL, payment_status text NOT NULL,
    fulfillment_status text, canceled boolean NOT NULL DEFAULT false,
    source_updated_at timestamptz NOT NULL, private_snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(platform,order_id))`);
  await connection.query('CREATE INDEX IF NOT EXISTS shusha_bridge_outbox_pending ON shusha_bridge_outbox(state,available_at)');
};
