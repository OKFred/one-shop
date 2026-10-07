
// Additive and idempotent: no existing order, catalog, setting or total changes.
export default async (connection) => {
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_payment_quote (
    order_id INT PRIMARY KEY REFERENCES "order"(order_id) ON DELETE CASCADE,
    revision INT NOT NULL DEFAULT 1 CHECK (revision > 0),
    currency VARCHAR(3) NOT NULL CHECK (currency IN ('GBP','EUR','USD')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    merchandise_usd NUMERIC(12,4) NOT NULL CHECK (merchandise_usd > 0),
    reference VARCHAR(120) NOT NULL,
    bank_details JSONB NOT NULL,
    wise_payment_url TEXT,
    status VARCHAR(16) NOT NULL CHECK (status IN ('confirmed','paid')),
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    receipt_confirmed_at TIMESTAMPTZ,
    CHECK ((status='paid') = (receipt_confirmed_at IS NOT NULL))
  )`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_payment_quote_audit (
    audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id INT NOT NULL REFERENCES "order"(order_id) ON DELETE CASCADE,
    revision INT NOT NULL,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(order_id,revision)
  )`);
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_payment_receipt (
    receipt_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id INT NOT NULL UNIQUE REFERENCES "order"(order_id) ON DELETE CASCADE,
    quote_revision INT NOT NULL,
    receipt_reference VARCHAR(120) NOT NULL UNIQUE,
    currency VARCHAR(3) NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    merchandise_usd NUMERIC(12,4) NOT NULL,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
};
