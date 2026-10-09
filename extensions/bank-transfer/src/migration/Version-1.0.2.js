// Additive only: existing orders retain NULL and all money/status is untouched.
export default async (connection) => {
  for (const table of ['cart', '"order"']) {
    await connection.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS shusha_shipping_preference varchar(80) CHECK (shusha_shipping_preference IS NULL OR char_length(shusha_shipping_preference) BETWEEN 1 AND 80)`);
  }
};
