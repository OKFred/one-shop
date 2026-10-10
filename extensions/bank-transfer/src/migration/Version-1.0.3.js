// Global receipt ownership is additive. Existing native receipts retain their
// exact money, statuses and references; normalized collisions block migration.
export default async connection => {
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_payment_receipt_registry (
    reference text PRIMARY KEY, platform text NOT NULL CHECK(platform IN ('evershop','shopify')),
    order_key text NOT NULL, currency varchar(3) NOT NULL, amount numeric(12,2) NOT NULL CHECK(amount>0),
    quote_revision integer NOT NULL CHECK(quote_revision>0), created_at timestamptz NOT NULL DEFAULT now(),
    record jsonb NOT NULL DEFAULT '{}'::jsonb)`);
  const legacy = (await connection.query(`SELECT r.receipt_reference,r.order_id,r.currency,r.amount::text,
    r.quote_revision,r.confirmed_at,o.uuid::text AS uuid FROM shusha_payment_receipt r
    JOIN "order" o ON o.order_id=r.order_id ORDER BY r.receipt_id`)).rows;
  for (const row of legacy) {
    const reference = row.receipt_reference.trim().replace(/\s+/g,' ').toUpperCase();
    const orderKey = `evershop:${row.uuid}`;
    await connection.query(`INSERT INTO shusha_payment_receipt_registry(reference,platform,order_key,currency,amount,quote_revision,created_at)
      VALUES($1,'evershop',$2,$3,$4,$5,$6) ON CONFLICT(reference) DO NOTHING`,
      [reference,orderKey,row.currency,row.amount,row.quote_revision,row.confirmed_at]);
    const existing = (await connection.query(`SELECT platform,order_key,currency,amount=$2::numeric AS same_amount,
      quote_revision FROM shusha_payment_receipt_registry WHERE reference=$1`,
      [reference,row.amount])).rows[0];
    if (!existing || existing.platform !== 'evershop' || existing.order_key !== orderKey || existing.currency !== row.currency ||
      existing.same_amount !== true || existing.quote_revision !== row.quote_revision) throw new Error('Existing receipt identity collision requires private merchant reconciliation');
  }
};
