#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// No dotenv auto-loading: the caller supplies a disposable DB explicitly.
const expected = process.env.BANK_TRANSFER_TEST_DB;
assert.equal(process.env.BANK_TRANSFER_TEST_ALLOW_WRITE, '1', 'Explicit isolated DB write permission required');
assert(expected && /(?:^|[_-])(?:test|candidate|integration)(?:[_-]|$)/i.test(expected), 'An isolated DB name is required');
assert.equal(process.env.DB_NAME, expected);
assert.equal(process.env.SHUSHA_JOBS_ENABLED || '0', '0', 'Background jobs must be disabled');
process.env.ALLOW_CONFIG_MUTATIONS = 'true';

const root = fileURLToPath(new URL('../../../', import.meta.url));
process.env.NODE_ENV = 'production';
process.env.NODE_CONFIG = process.env.NODE_CONFIG || fs.readFileSync(path.join(root, 'deployment/config.shusha.json'), 'utf8');
const native = path.join(root, 'packages/evershop/dist');
const importFile = (file) => import(pathToFileURL(file).href);
const { getCoreModules } = await importFile(path.join(native, 'bin/lib/loadModules.js'));
const { loadBootstrapScript } = await importFile(path.join(native, 'bin/lib/bootstrap/bootstrap.js'));
const { loadModuleRoutes } = await importFile(path.join(native, 'lib/router/loadModuleRoutes.js'));
const { getRoutes } = await importFile(path.join(native, 'lib/router/Router.js'));
const { getEnabledExtensions } = await importFile(path.join(native, 'bin/extension/index.js'));
const bankPath = path.join(root, 'extensions/bank-transfer/dist');
for (const module of getCoreModules()) { await loadBootstrapScript(module); loadModuleRoutes(module.path); }
const extensions = getEnabledExtensions();
assert(extensions.some((extension) => extension.name === 'bank-transfer'), 'The candidate must enable bank-transfer');
for (const extension of extensions) { await loadBootstrapScript(extension); loadModuleRoutes(extension.path); }
const { pool } = await import('@evershop/evershop/lib/postgres');
const { refreshSetting } = await import('@evershop/evershop/setting/services');
const { manualQuoteProvider } = await import('../dist/services/manualQuote.js');
const { getAllShippingProviders, getAvailablePaymentMethods } = await import('@evershop/evershop/checkout/services');
const { confirmQuote, recordReceipt, getOrderQuote } = await import('../dist/services/orderPayments.js');
const { default: resolvers } = await import('../dist/graphql/types/OrderPayment/OrderPayment.resolvers.js');
const { default: migrate } = await import('../dist/migration/Version-1.0.0.js');
const { default: migrateShipping } = await import('../dist/migration/Version-1.0.1.js');
const { countries } = await import('@evershop/evershop/lib/locale/countries');
const { registerEmailService } = await import('@evershop/evershop/lib/mail/emailHelper');
const { loadSubscribers } = await importFile(path.join(native, 'lib/event/loadSubscribers.js'));
const { graphql } = await import('graphql');
const { rebuildStoreFrontSchema } = await importFile(path.join(native, 'modules/graphql/services/buildStoreFrontSchema.js'));
const { rebuildSchema } = await importFile(path.join(native, 'modules/graphql/services/buildSchema.js'));
const storefrontSchema = await rebuildStoreFrontSchema();
const adminSchema = await rebuildSchema();

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shusha-bank-integration-'));
const receivingFile = path.join(directory, 'receiving.json');
const priorReceiving = process.env.SHUSHA_WISE_RECEIVING_CONFIG;
fs.writeFileSync(receivingFile, JSON.stringify({ openLink: 'https://wise.com/pay/business/synthetic-only', accounts: { GBP: { fields: [{ label: 'Beneficiary', value: 'Synthetic fixture' }, { label: 'Account', value: '00000000' }] }, EUR: { fields: [{ label: 'Beneficiary', value: 'Synthetic fixture' }] } } }), { mode: 0o600 });
process.env.SHUSHA_WISE_RECEIVING_CONFIG = receivingFile;
const created = [];
let previousSetting;
let cartId;
let customerId;
let checks = 0;
let emailAttempts = 0;
try {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, expected);
  previousSetting = (await pool.query('SELECT * FROM setting WHERE name=$1', ['bankTransferPaymentStatus'])).rows[0] || null;
  await pool.query("INSERT INTO setting(name,value,is_json) VALUES('bankTransferPaymentStatus','1',FALSE) ON CONFLICT(name) DO UPDATE SET value='1',is_json=FALSE");
  await refreshSetting();
  // Instrument only this synthetic test process. An unexpected attempt throws;
  // it never returns a fake success and never invokes an external provider.
  registerEmailService({ sendEmail: async () => { emailAttempts++; throw new Error('Unexpected synthetic email attempt'); } });
  const nativeSubscribers = await loadSubscribers(getCoreModules());
  const autoEmailSubscribers = nativeSubscribers.filter(({ subscriber }) => ['sendOrderConfirmationEmail', 'sendCustomerWelcomeEmail', 'sendShipmentCreatedEmail', 'sendShipmentDeliveredEmail'].includes(subscriber.name));
  assert.equal(autoEmailSubscribers.length, 4); checks++;
  assert(nativeSubscribers.some(({ event }) => event === 'product_created')); assert(nativeSubscribers.some(({ event }) => event === 'category_updated')); assert(nativeSubscribers.length > autoEmailSubscribers.length); checks += 3;
  for (const { subscriber } of autoEmailSubscribers) await subscriber({ email: 'synthetic@example.invalid', notifyCustomer: true });
  assert.equal(emailAttempts, 0); checks++;
  await migrate(pool); await migrate(pool);
  await migrateShipping(pool); await migrateShipping(pool);
  const zone = (await pool.query('SELECT z.shipping_zone_id,p.is_enabled FROM shipping_zone z JOIN shipping_zone_provider p ON p.zone_id=z.shipping_zone_id WHERE z.uuid=$1 AND p.provider_code=$2', ['ed8f7156-3636-4d8b-8e64-0e894795d7f6', 'shusha'])).rows[0];
  assert.equal(zone.is_enabled, true); checks++;
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM shipping_zone_country WHERE zone_id=$1', [zone.shipping_zone_id])).rows[0].count), countries.length); checks++;
  for (const routeId of ['bankTransferConfirmQuote', 'bankTransferRecordReceipt']) { assert.equal(getRoutes().find((r) => r.id === routeId)?.access, 'private'); checks++; }
  const context = { currency: 'USD', destination: { country: 'GB', province: 'GB-ENG' } };
  assert.equal((await manualQuoteProvider.getMethods(context))[0].cost, 0); checks++;
  const validateDetached = manualQuoteProvider.validateMethod;
  assert.equal((await validateDetached(context, 'manual_quote')).code, 'manual_quote'); checks++;
  assert.deepEqual(await manualQuoteProvider.getMethods({ ...context, currency: 'GBP' }), []); checks++;
  assert.deepEqual(await manualQuoteProvider.getMethods({ ...context, destination: { country: 'ZZ' } }), []); checks++;
  assert.equal(await validateDetached(context, 'other'), null); checks++;
  for (const provider of await getAllShippingProviders()) {
    if (provider.code !== 'shusha') { assert.deepEqual(await provider.getMethods(context), []); checks++; }
  }
  assert.deepEqual((await getAvailablePaymentMethods({ cartTotal: 9.98 })).map((p) => p.code), ['banktransfer']); checks++;

  const amounts = [9.98, 14.99, 19.98];
  customerId = (await pool.query('INSERT INTO customer(email,password,full_name,group_id) VALUES($1,$2,$3,NULL) RETURNING customer_id', [`bank-${crypto.randomUUID()}@example.invalid`, 'SYNTHETIC-NEVER-LOGIN', 'Synthetic fixture'])).rows[0].customer_id;
  cartId = (await pool.query(`INSERT INTO cart(currency,status,sub_total,sub_total_incl_tax,sub_total_with_discount,sub_total_with_discount_incl_tax,total_qty,tax_amount,tax_amount_before_discount,shipping_tax_amount,grand_total) VALUES('USD',FALSE,0,0,0,0,0,0,0,0,0) RETURNING cart_id`)).rows[0].cart_id;
  for (const amount of amounts) {
    const order = (await pool.query(`INSERT INTO "order"(uuid,order_number,cart_id,currency,status,payment_status,shipment_status,payment_method,payment_method_name,shipping_fee_excl_tax,shipping_fee_incl_tax,sub_total,sub_total_incl_tax,sub_total_with_discount,sub_total_with_discount_incl_tax,total_qty,tax_amount,tax_amount_before_discount,shipping_tax_amount,grand_total,customer_email,shipping_method_data,no_shipping_required) VALUES($1,$2,$3,'USD','new','pending','pending','banktransfer','T/T',0,0,$4,$4,$4,$4,1,0,0,0,$4,'fixture@example.invalid',$5,FALSE) RETURNING *`, [crypto.randomUUID(), `TEST-${crypto.randomUUID()}`, cartId, amount, JSON.stringify({ provider_code: 'shusha', method_code: 'manual_quote', snapshot: { name: 'Shipping quotation pending', cost: 0 } })])).rows[0];
    created.push(order);
  }
  const [first, second, third] = created;
  await pool.query('UPDATE "order" SET customer_id=$1 WHERE order_id=$2', [customerId, first.order_id]);
  await pool.query(`UPDATE "order" SET shipping_method_data=jsonb_set(shipping_method_data,'{provider_code}','"core"'::jsonb) WHERE order_id=$1`, [second.order_id]);
  await migrateShipping(pool);
  const corrected = (await pool.query('SELECT shipping_method_data,grand_total,payment_status,shipment_status FROM "order" WHERE order_id=$1', [second.order_id])).rows[0];
  assert.equal(corrected.shipping_method_data.provider_code, 'shusha'); assert.equal(corrected.shipping_method_data.method_code, 'manual_quote'); assert.equal(corrected.grand_total, second.grand_total); assert.equal(corrected.payment_status, 'pending'); assert.equal(corrected.shipment_status, 'pending'); checks += 5;
  assert.equal(await getOrderQuote(first.order_id), null); checks++;
  await assert.rejects(() => recordReceipt(first.uuid, { currency: 'GBP', amount: '12.00', receiptReference: 'TEST-UNCONFIRMED', quoteRevision: 1, receivedConfirmed: true }), /quote first/); checks++;
  await assert.rejects(() => confirmQuote(first.uuid, { currency: 'USD', amount: '9.98', shippingDeferred: true, expectedQuoteRevision: 0 }), /no configured/); checks++;
  const quote = await confirmQuote(first.uuid, { currency: 'GBP', amount: '12.00', shippingDeferred: true, expectedQuoteRevision: 0 });
  assert.equal(quote.quote.revision, 1); assert.equal(quote.quote.status, 'confirmed'); assert.equal(quote.quote.merchandiseUsd, '9.98'); checks += 3;
  assert.equal((await confirmQuote(first.uuid, { currency: 'GBP', amount: '12.00', shippingDeferred: true, expectedQuoteRevision: 0 })).unchanged, true); checks++;
  await assert.rejects(() => confirmQuote(first.uuid, { currency: 'EUR', amount: '13.00', shippingDeferred: true, expectedQuoteRevision: 0 }), /quote changed/); checks++;
  const updated = await confirmQuote(first.uuid, { currency: 'EUR', amount: '13.00', shippingDeferred: true, expectedQuoteRevision: 1 });
  assert.equal(updated.quote.revision, 2); checks++;
  const receipt = { currency: 'EUR', amount: '13.00', receiptReference: `TEST-${crypto.randomUUID()}`, quoteRevision: 2, receivedConfirmed: true };
  for (const payload of [{ ...receipt, receivedConfirmed: false }, { ...receipt, quoteRevision: 1 }, { ...receipt, amount: '12.99' }, { ...receipt, currency: 'GBP' }]) { await assert.rejects(() => recordReceipt(first.uuid, payload)); checks++; }
  assert.equal((await recordReceipt(first.uuid, receipt)).quote.status, 'paid'); checks++;
  const after = (await pool.query('SELECT grand_total,payment_status,shipment_status,status FROM "order" WHERE order_id=$1', [first.order_id])).rows[0];
  assert.equal(after.grand_total, first.grand_total); assert.equal(after.payment_status, 'paid'); assert.equal(after.shipment_status, 'pending'); assert.equal(after.status, 'processing'); checks += 4;
  assert.equal((await recordReceipt(first.uuid, receipt)).alreadyRecorded, true); checks++;
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM payment_transaction WHERE payment_transaction_order_id=$1', [first.order_id])).rows[0].count), 1); checks++;
  await confirmQuote(second.uuid, { currency: 'EUR', amount: '13.00', shippingDeferred: true, expectedQuoteRevision: 0 });
  await assert.rejects(() => recordReceipt(second.uuid, { ...receipt, quoteRevision: 1 }), /already been registered/); checks++;
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM shusha_payment_receipt WHERE order_id=$1', [second.order_id])).rows[0].count), 0); checks++;
  await pool.query(`CREATE FUNCTION shusha_bank_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payment_transaction_order_id=${Number(second.order_id)} THEN RAISE EXCEPTION 'isolated payment rollback'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER shusha_bank_test_reject BEFORE INSERT ON payment_transaction FOR EACH ROW EXECUTE FUNCTION shusha_bank_test_reject()');
  try { await assert.rejects(() => recordReceipt(second.uuid, { ...receipt, quoteRevision: 1, receiptReference: `ROLLBACK-${crypto.randomUUID()}` }), /isolated payment rollback/); checks++; }
  finally { await pool.query('DROP TRIGGER shusha_bank_test_reject ON payment_transaction'); await pool.query('DROP FUNCTION shusha_bank_test_reject()'); }
  assert.equal((await getOrderQuote(second.order_id)).status, 'confirmed'); assert.equal(Number((await pool.query('SELECT count(*) AS count FROM shusha_payment_receipt WHERE order_id=$1', [second.order_id])).rows[0].count), 0); checks += 2;
  await pool.query("UPDATE \"order\" SET status='canceled' WHERE order_id=$1", [third.order_id]);
  await assert.rejects(() => confirmQuote(third.uuid, { currency: 'GBP', amount: '15.00', shippingDeferred: true, expectedQuoteRevision: 0 }), /cannot receive/); checks++;
  await pool.query("UPDATE \"order\" SET status='canceled' WHERE order_id=$1", [second.order_id]);
  assert.equal(await getOrderQuote(second.order_id), null); checks++;
  await assert.rejects(() => recordReceipt(second.uuid, { ...receipt, quoteRevision: 1, receiptReference: `CANCELED-${crypto.randomUUID()}` }), /cannot receive/); checks++;
  assert.equal(await resolvers.Query.order(null, { uuid: first.uuid }, { pool }), null); checks++;
  assert.equal(await resolvers.Query.order(null, { uuid: first.uuid }, { pool, customer: { customer_id: 2147483647 } }), null); checks++;
  assert.equal(await resolvers.Query.bankTransferPaymentOrder(null, null, { pool }), null); checks++;
  assert.deepEqual(await resolvers.Query.bankTransferCustomerPayments(null, null, { pool }), []); checks++;
  const guest = await resolvers.Query.bankTransferPaymentOrder(null, null, { pool, bankTransferGuestUuid: first.uuid });
  assert.equal(guest.orderNumber, first.order_number); assert.equal(Object.hasOwn(guest, 'customerEmail'), false); checks += 2;
  const runGraphql = (source, contextValue = {}) => graphql({ schema: storefrontSchema, source, contextValue: { pool, ...contextValue } });
  const anonymousOrder = await runGraphql(`{ order(uuid:"${first.uuid}") { orderNumber customerEmail } bankTransferCustomerPayments { orderNumber } }`);
  assert.equal(anonymousOrder.errors, undefined); assert.equal(anonymousOrder.data.order, null); assert.deepEqual(anonymousOrder.data.bankTransferCustomerPayments, []); checks += 3;
  const guestPayment = await runGraphql('{ bankTransferPaymentOrder { orderNumber bankTransferQuote { status amount } } }', { bankTransferGuestUuid: first.uuid });
  assert.equal(guestPayment.errors, undefined); assert.equal(guestPayment.data.bankTransferPaymentOrder.orderNumber, first.order_number); assert.equal(guestPayment.data.bankTransferPaymentOrder.bankTransferQuote.status, 'paid'); checks += 3;
  const guestPii = await runGraphql('{ bankTransferPaymentOrder { customerEmail shippingAddress { fullName } } }', { bankTransferGuestUuid: first.uuid });
  assert(guestPii.errors?.length >= 1); checks++;
  const wrongCustomer = await runGraphql(`{ order(uuid:"${first.uuid}") { orderNumber } bankTransferCustomerPaymentOrder(uuid:"${first.uuid}") { orderNumber } }`, { customer: { customer_id: 2147483647 } });
  assert.equal(wrongCustomer.errors, undefined); assert.equal(wrongCustomer.data.order, null); assert.equal(wrongCustomer.data.bankTransferCustomerPaymentOrder, null); checks += 3;
  const ownCustomer = await runGraphql(`{ order(uuid:"${first.uuid}") { orderNumber bankTransferPaymentUrl } bankTransferCustomerPayments { orderNumber bankTransferPaymentUrl } bankTransferCustomerPaymentOrder(uuid:"${first.uuid}") { orderNumber bankTransferQuote { status } } }`, { customer: { customer_id: customerId } });
  assert.equal(ownCustomer.errors, undefined); assert.equal(ownCustomer.data.order.orderNumber, first.order_number); assert.equal(ownCustomer.data.bankTransferCustomerPayments.length, 1); assert.equal(ownCustomer.data.bankTransferCustomerPayments[0].orderNumber, first.order_number); assert.match(ownCustomer.data.bankTransferCustomerPayments[0].bankTransferPaymentUrl, /\/payment\//); assert.equal(ownCustomer.data.bankTransferCustomerPaymentOrder.bankTransferQuote.status, 'paid'); checks += 6;
  const nativeCheckout = await runGraphql(`{ order(uuid:"${first.uuid}") { orderNumber bankTransferPaymentUrl } }`, { orderId: first.uuid });
  assert.equal(nativeCheckout.errors, undefined); assert.equal(nativeCheckout.data.order.orderNumber, first.order_number); checks += 2;
  const adminOrder = await graphql({ schema: adminSchema, source: `{ order(uuid:"${first.uuid}") { orderNumber bankTransferQuote { status } } bankTransferReceivingConfig { ready currencies } }`, contextValue: { pool, user: { user_id: 1 } } });
  assert.equal(adminOrder.errors, undefined); assert.equal(adminOrder.data.order.orderNumber, first.order_number); assert.equal(adminOrder.data.bankTransferReceivingConfig.ready, true); checks += 3;
  console.log(JSON.stringify({ passed: true, checks, providerCalls: 0, customerMessages: 0, automaticEmailAttempts: emailAttempts, nativeNonMailSubscribersPreserved: true, preservedNativeUsdTotals: true, quoteRevisionProtected: true, duplicateReceiptRejected: true, atomicRollbackVerified: true, authenticatedOwnershipVerified: true, compiledGraphqlSchemaMerged: true }));
} finally {
  const ids = created.map((o) => o.order_id);
  if (ids.length) {
    await pool.query("DELETE FROM event WHERE data::jsonb->>'orderId'=ANY($1::text[])", [ids.map(String)]);
    await pool.query('DELETE FROM "order" WHERE order_id=ANY($1::int[])', [ids]);
  }
  if (cartId) await pool.query('DELETE FROM cart WHERE cart_id=$1', [cartId]);
  if (customerId) await pool.query('DELETE FROM customer WHERE customer_id=$1', [customerId]);
  if (previousSetting) await pool.query('UPDATE setting SET value=$1,is_json=$2 WHERE name=$3', [previousSetting.value, previousSetting.is_json, 'bankTransferPaymentStatus']);
  else await pool.query('DELETE FROM setting WHERE name=$1', ['bankTransferPaymentStatus']);
  await refreshSetting();
  if (priorReceiving === undefined) delete process.env.SHUSHA_WISE_RECEIVING_CONFIG; else process.env.SHUSHA_WISE_RECEIVING_CONFIG = priorReceiving;
  fs.unlinkSync(receivingFile); fs.rmdirSync(directory);
  await pool.end();
}
