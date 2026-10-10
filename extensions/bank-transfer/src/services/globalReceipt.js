export async function claimNativeReceipt(connection,{reference,orderUuid,currency,amount,quoteRevision}) {
  if (connection.INTRANSACTION !== true) throw new Error('Receipt ownership requires the original order transaction');
  const orderKey = `evershop:${orderUuid}`;
  await connection.query(`INSERT INTO shusha_payment_receipt_registry(reference,platform,order_key,currency,amount,quote_revision)
    VALUES($1,'evershop',$2,$3,$4,$5) ON CONFLICT(reference) DO NOTHING`,[reference,orderKey,currency,amount,quoteRevision]);
  const record = (await connection.query(`SELECT platform,order_key,currency,amount=$2::numeric AS same_amount,quote_revision
    FROM shusha_payment_receipt_registry WHERE reference=$1 FOR UPDATE`,[reference,amount])).rows[0];
  if (!record || record.platform !== 'evershop' || record.order_key !== orderKey || record.currency !== currency ||
    record.same_amount !== true || record.quote_revision !== quoteRevision) throw new Error('This actual bank receipt is already registered to another order or amount');
}
