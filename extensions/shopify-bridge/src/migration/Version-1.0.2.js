// Native bank-transfer Version-1.0.3 must create and seed the shared receipt
// registry before this migration. Never silently open an empty duplicate ledger.
export default async connection => {
  const registry = await connection.query("SELECT to_regclass('shusha_payment_receipt_registry') AS registry");
  if (!registry.rows[0]?.registry) throw new Error('Native global receipt migration must run before Shopify payments');
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_payment_quote (
    shop text NOT NULL, order_id text NOT NULL, revision integer NOT NULL CHECK(revision>=0),
    payment_version integer NOT NULL CHECK(payment_version>=1), status text NOT NULL,
    record jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(shop,order_id))`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_payment_quote_history (
    shop text NOT NULL, order_id text NOT NULL, payment_version integer NOT NULL CHECK(payment_version>=1),
    revision integer NOT NULL CHECK(revision>=0), record jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(shop,order_id,payment_version))`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_payment_operation (
    shop text NOT NULL, operation_key text NOT NULL, order_id text NOT NULL, kind text NOT NULL,
    input_hash text NOT NULL, status text NOT NULL, record jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(shop,operation_key))`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_bridge_payment_receipt (
    reference text PRIMARY KEY REFERENCES shusha_payment_receipt_registry(reference),
    shop text NOT NULL, order_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await connection.query('CREATE INDEX IF NOT EXISTS shusha_bridge_payment_receipt_order ON shusha_bridge_payment_receipt(shop,order_id)');
};
