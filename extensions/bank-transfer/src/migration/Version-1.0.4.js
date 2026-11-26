// Bind to the immutable quote revision, so repricing never overwrites an issued invoice.
export default async (connection) => {
  await connection.query(`CREATE TABLE IF NOT EXISTS shusha_paypal_invoice (
    order_id integer NOT NULL,
    quote_revision integer NOT NULL,
    environment text NOT NULL CHECK (environment IN ('live','sandbox')),
    invoice_id text NOT NULL,
    recipient_url text NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id,quote_revision),
    UNIQUE (environment,invoice_id),
    FOREIGN KEY (order_id,quote_revision) REFERENCES shusha_payment_quote_audit(order_id,revision) ON DELETE CASCADE
  )`);
  await connection.query(`ALTER TABLE shusha_payment_receipt
    ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'bank' CHECK (channel IN ('bank','paypal'))`);
};
