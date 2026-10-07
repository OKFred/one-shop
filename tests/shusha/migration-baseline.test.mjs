import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hash, snapshotRows, validateSnapshot, captureDatabase } from '../../deployment/capture-baseline.mjs';
import { compareSnapshots } from '../../deployment/verify-baseline.mjs';

function table(rows, fields, keys = ['id'], types = {}, values = []) {
  return { table: 'synthetic', exists: true, missingColumns: [], ...snapshotRows(rows, { keys, fields, columnTypes: types, values }) };
}

function seal(snapshot) {
  const { contentSha256, ...body } = snapshot;
  return { ...body, contentSha256: hash(body) };
}

function baseline() {
  return seal({
    schemaVersion: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    sourceVersion: '1.2.2',
    tables: {
      orders: table([{ id: 1, currency: 'USD', grand_total: '8.9900', payment_status: 'pending', shipment_status: 'pending' }], ['id', 'currency', 'grand_total', 'payment_status', 'shipment_status'], ['id'], { id: 'integer', grand_total: 'numeric' }),
      orderItems: table([{ id: 2, order_id: 1, qty: 1, price: '8.9900' }], ['id', 'order_id', 'qty', 'price'], ['id'], { id: 'integer', order_id: 'integer', qty: 'integer', price: 'numeric' }),
      customers: table([{ id: 3, email: 'test-only@example.invalid', password: 'synthetic-password-hash' }], ['id', 'email', 'password']),
      inventory: table([{ id: 4, qty: 998 }], ['id', 'qty'], ['id'], { id: 'integer', qty: 'integer' }),
      quotes: table([{ id: 5, amount: '10.00', bank_details: { alpha: 'synthetic-only', beta: 'fixture' } }], ['id', 'amount', 'bank_details']),
      cmsPages: table([], ['cms_page_id', 'uuid'], ['cms_page_id', 'uuid']),
      cmsDescriptions: table([], ['cms_page_description_id', 'cms_page_description_cms_page_id', 'url_key', 'content'], ['cms_page_description_id', 'cms_page_description_cms_page_id']),
      urlRewrites: table([], ['url_rewrite_id', 'request_path', 'target_path', 'entity_uuid', 'entity_type'], ['url_rewrite_id']),
      receipts: { table: 'synthetic-receipt', exists: false, columns: [], count: 0, records: [] }
    },
    nativeMigrations: [{ module: 'cms', version: '1.1.1' }],
    nativeShipments: {
      orders: [{ order_id: 1, uuid: 'synthetic-order-uuid', shipment_status: 'pending', shipping_method: 'manual_quote', payment_method: 'banktransfer' }],
      shipments: [{ shipment_id: 7, shipment_order_id: 1, carrier: null, tracking_number: null, created_at: new Date('2026-01-01T00:00:00.000Z') }]
    }
  });
}

function migrated(before = baseline()) {
  const after = JSON.parse(JSON.stringify(before));
  after.sourceVersion = '2.2.1';
  after.nativeMigrations = [{ module: 'cms', version: '1.4.0' }, { module: 'stripe', version: '1.0.0' }, { module: 'paypal', version: '1.0.0' }];
  after.nativeShipments.orders[0].shipping_method_data = { provider_code: 'shusha', method_code: 'manual_quote' };
  delete after.nativeShipments.orders[0].shipping_method;
  after.nativeShipments.shipments[0].package_id = null;
  after.nativeShipments.shipments[0].status = 'pending';
  return seal(after);
}

test('canonical hashing is stable across object ordering, dates and JSON persistence', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.equal(canonical(new Date('2026-01-01T00:00:00.000Z')), canonical('2026-01-01T00:00:00.000Z'));
  const before = baseline();
  assert.doesNotThrow(() => validateSnapshot(JSON.parse(JSON.stringify(before))));
  const corrupted = JSON.parse(JSON.stringify(before));
  corrupted.tables.orders.count = 99;
  assert.throws(() => validateSnapshot(corrupted), /integrity/);
});

test('numeric scale changes do not reprice rows while value changes are detected', () => {
  const options = { keys: ['id'], fields: ['id', 'price'], columnTypes: { id: 'integer', price: 'numeric' } };
  const before = snapshotRows([{ id: 1, price: '8.9900' }], options);
  const same = snapshotRows([{ id: '1', price: '8.99' }], options);
  const changed = snapshotRows([{ id: 1, price: '9.99' }], options);
  assert.equal(before.digest, same.digest);
  assert.notEqual(before.digest, changed.digest);
});

test('customer and bank records contain digests rather than plaintext values', () => {
  const snapshot = baseline();
  const customerSerialized = JSON.stringify(snapshot.tables.customers);
  const quoteSerialized = JSON.stringify(snapshot.tables.quotes);
  assert.equal(customerSerialized.includes('test-only@example.invalid'), false);
  assert.equal(customerSerialized.includes('synthetic-password-hash'), false);
  assert.equal(quoteSerialized.includes('synthetic-only'), false);
  assert.match(snapshot.tables.customers.records[0].fieldDigests.password, /^[a-f0-9]{64}$/);
});

test('additive native shipment fields and manual provider conversion preserve baseline', () => {
  const result = compareSnapshots(baseline(), migrated());
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.mismatches, []);
});

test('lost orders, changed item quantities, stock, credentials and quotes report only field/count labels', () => {
  const before = baseline();
  const after = migrated(before);
  after.tables.orders = table([], before.tables.orders.columns);
  after.tables.orderItems = table([{ id: 2, order_id: 1, qty: 2, price: '8.9900' }], before.tables.orderItems.columns, ['id'], before.tables.orderItems.columnTypes);
  after.tables.inventory = table([{ id: 4, qty: 999 }], before.tables.inventory.columns, ['id'], before.tables.inventory.columnTypes);
  after.tables.customers = table([{ id: 3, email: 'test-only@example.invalid', password: 'changed-synthetic-password-hash' }], before.tables.customers.columns);
  after.tables.quotes = table([{ id: 5, amount: '11.00', bank_details: { alpha: 'synthetic-only', beta: 'fixture' } }], before.tables.quotes.columns);
  const result = compareSnapshots(before, seal(after));
  assert.equal(result.status, 'mismatch');
  const labels = result.mismatches.map(row => row.field);
  for (const field of ['orders.record_missing', 'orderItems.qty', 'inventory.qty', 'customers.password', 'quotes.amount']) assert.equal(labels.includes(field), true);
  const output = JSON.stringify(result);
  assert.equal(output.includes('example.invalid'), false);
  assert.equal(output.includes('changed-synthetic-password-hash'), false);
  assert.equal(output.includes('synthetic-only'), false);
});

test('upstream pending shipment backfill and wrong manual provider are cutover failures', () => {
  const before = baseline();
  const after = migrated(before);
  after.nativeShipments.orders[0].shipment_status = 'shipped';
  after.nativeShipments.orders[0].shipping_method_data.provider_code = 'core';
  after.nativeShipments.shipments[0].status = 'shipped';
  const labels = compareSnapshots(before, seal(after)).mismatches.map(row => row.field);
  assert.equal(labels.includes('nativeShipments.pending_order_became_shipped'), true);
  assert.equal(labels.includes('nativeShipments.pending_shipment_became_shipped'), true);
  assert.equal(labels.includes('nativeShipments.manual_quote_provider_identity'), true);
});

test('missing legacy shipment and changed tracking evidence are reported', () => {
  const before = baseline();
  const missing = migrated(before);
  missing.nativeShipments.shipments = [];
  assert.equal(compareSnapshots(before, seal(missing)).mismatches.some(row => row.field === 'nativeShipments.legacy_shipment_missing'), true);
  const changed = migrated(before);
  changed.nativeShipments.shipments[0].tracking_number = 'synthetic-new-evidence';
  assert.equal(compareSnapshots(before, seal(changed)).mismatches.some(row => row.field === 'nativeShipments.legacy_tracking_number'), true);
});

test('new tables are permitted but additions or dropped columns in protected ledgers are flagged', () => {
  const before = baseline();
  const after = migrated(before);
  after.tables.receipts = table([], ['id']);
  assert.equal(compareSnapshots(before, seal(after)).status, 'verified');
  after.tables.customers = table([{ id: 3 }, { id: 8 }], ['id']);
  after.tables.customers.missingColumns = ['email', 'password'];
  const labels = compareSnapshots(before, seal(after)).mismatches.map(row => row.field);
  assert.equal(labels.includes('customers.column_missing_email'), true);
  assert.equal(labels.includes('customers.record_added'), true);
});

test('database capture is repeatable-read/read-only and preserves hashed credentials across additive migration', async () => {
  const definitions = {
    order: { order_id: 'integer', uuid: 'uuid', order_number: 'text', currency: 'text', grand_total: 'numeric', shipment_status: 'text', payment_status: 'text', payment_method: 'text', shipping_method: 'text' },
    order_item: { order_item_id: 'integer', uuid: 'uuid', order_item_order_id: 'integer', qty: 'integer', product_price: 'numeric' },
    customer: { customer_id: 'integer', uuid: 'uuid', email: 'text', password: 'text' },
    admin_user: { admin_user_id: 'integer', uuid: 'uuid', email: 'text', password: 'text' },
    customer_address: { customer_address_id: 'integer', uuid: 'uuid' },
    order_address: { order_address_id: 'integer', uuid: 'uuid' },
    product: { product_id: 'integer', uuid: 'uuid', sku: 'text', price: 'numeric' },
    product_inventory: { product_inventory_id: 'integer', product_inventory_product_id: 'integer', qty: 'integer' },
    category: { category_id: 'integer', uuid: 'uuid' },
    product_description: { product_description_product_id: 'integer', url_key: 'text' },
    category_description: { category_description_category_id: 'integer', url_key: 'text' },
    cms_page: { cms_page_id: 'integer', uuid: 'uuid' },
    cms_page_description: { cms_page_description_id: 'integer', cms_page_description_cms_page_id: 'integer', url_key: 'text', content: 'text' },
    url_rewrite: { url_rewrite_id: 'integer', request_path: 'text', target_path: 'text' },
    payment_transaction: { payment_transaction_id: 'integer', uuid: 'uuid' },
    shipment: { shipment_id: 'integer', shipment_order_id: 'integer', created_at: 'timestamp with time zone' }
  };
  const data = {
    order: [{ order_id: 1, uuid: 'fixture-order-uuid', order_number: 'test-1', currency: 'USD', grand_total: '8.9900', shipment_status: 'pending', payment_status: 'pending', payment_method: 'banktransfer', shipping_method: 'manual_quote' }],
    customer: [{ customer_id: 1, uuid: 'fixture-customer-uuid', email: 'test-only@example.invalid', password: 'test-only-credential-hash' }]
  };
  const calls = [];
  const client = { async query(sql, args = []) {
    calls.push(sql);
    if (sql.includes('information_schema.columns')) return { rows: Object.entries(definitions[args[0]] || {}).map(([column_name, data_type]) => ({ column_name, data_type })) };
    const match = sql.match(/ FROM "?([a-z_]+)"?(?: |$)/);
    return { rows: structuredClone(match ? data[match[1]] || [] : []) };
  } };
  const before = await captureDatabase(client);
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(calls.some(sql => /^(?:INSERT|UPDATE|DELETE|ALTER)/.test(sql)), false);
  assert.equal(JSON.stringify(before).includes('test-only@example.invalid'), false);
  assert.equal(JSON.stringify(before).includes('test-only-credential-hash'), false);
  definitions.customer.meta_data = 'jsonb';
  data.customer[0].meta_data = {};
  delete definitions.order.shipping_method;
  definitions.order.shipping_method_data = 'jsonb';
  delete data.order[0].shipping_method;
  data.order[0].shipping_method_data = { provider_code: 'shusha', method_code: 'manual_quote' };
  const after = await captureDatabase(client, { sourceVersion: '2.2.1', baseline: before });
  assert.equal(compareSnapshots(before, after).status, 'verified');
});

test('database capture failure rolls back the read-only snapshot', async () => {
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.includes('information_schema')) throw new Error('synthetic catalog failure');
    return { rows: [] };
  } };
  await assert.rejects(captureDatabase(client), /catalog failure/);
  assert.equal(calls.at(-1), 'ROLLBACK');
});

function paymentFixture(method = 'stripe', oldStatus = 'failed', newStatus = 'stripe_failed') {
  const original = baseline();
  const fields = ['id', 'payment_method', 'payment_status', 'currency', 'grand_total', 'shipment_status'];
  const types = { id: 'integer', grand_total: 'numeric' };
  const row = { id: 1, payment_method: method, payment_status: oldStatus, currency: 'USD', grand_total: '8.9900', shipment_status: 'pending' };
  original.tables.orders = table([row], fields, ['id'], types, fields);
  const before = seal(original);
  const after = migrated(before);
  after.tables.orders = table([{ ...row, payment_status: newStatus }], fields, ['id'], types, fields);
  return { before, after: seal(after), row, fields, types };
}

test('verified native Stripe/PayPal status aliases preserve meaning without allowing T/T or wrong-provider changes', () => {
  for (const [method, from, to] of [['stripe', 'failed', 'stripe_failed'], ['stripe', 'paid', 'stripe_captured'], ['paypal', 'authorized', 'paypal_authorized']]) {
    const fixture = paymentFixture(method, from, to);
    const result = compareSnapshots(fixture.before, fixture.after);
    assert.equal(result.status, 'verified');
    assert.equal(result.nativeMappings.paymentStatusCanonicalizations, 1);
  }
  for (const [method, from, to] of [['stripe', 'failed', 'paypal_failed'], ['banktransfer', 'failed', 'stripe_failed'], ['banktransfer', 'pending', 'paid'], ['stripe', 'pending', 'stripe_captured']]) {
    const fixture = paymentFixture(method, from, to);
    const result = compareSnapshots(fixture.before, fixture.after);
    assert.equal(result.status, 'mismatch');
    assert.equal(result.mismatches.some(row => row.field === 'orders.payment_status'), true);
  }
});

test('native payment alias requires proven migration and cannot conceal changed money or provider', () => {
  const { before, after, row, fields, types } = paymentFixture();
  after.nativeMigrations = after.nativeMigrations.filter(row => row.module !== 'stripe');
  assert.equal(compareSnapshots(before, seal(after)).status, 'mismatch');
  const changedAmount = paymentFixture();
  changedAmount.after.tables.orders = table([{ ...row, grand_total: '9.99', payment_status: 'stripe_failed' }], fields, ['id'], types, fields);
  assert.equal(compareSnapshots(changedAmount.before, seal(changedAmount.after)).mismatches.some(row => row.field === 'orders.grand_total'), true);
  const changedMethod = paymentFixture();
  changedMethod.after.tables.orders = table([{ ...row, payment_method: 'paypal', payment_status: 'stripe_failed' }], fields, ['id'], types, fields);
  const result = compareSnapshots(changedMethod.before, seal(changedMethod.after));
  assert.equal(result.mismatches.some(row => row.field === 'orders.payment_method'), true);
  assert.equal(result.mismatches.some(row => row.field === 'orders.payment_status'), true);
});

function cmsFixture() {
  const original = baseline();
  const pageFields = ['cms_page_id', 'uuid', 'status'];
  const descriptionFields = ['cms_page_description_id', 'cms_page_description_cms_page_id', 'url_key', 'content'];
  const rewriteFields = ['url_rewrite_id', 'request_path', 'target_path', 'entity_uuid', 'entity_type'];
  original.tables.cmsPages = table([{ cms_page_id: 20, uuid: 'synthetic-cms-uuid', status: true }], pageFields, ['cms_page_id', 'uuid'], { cms_page_id: 'integer' }, pageFields);
  const description = { cms_page_description_id: 21, cms_page_description_cms_page_id: 20, url_key: 'synthetic-policy', content: '<p>Synthetic private merchant content</p>' };
  original.tables.cmsDescriptions = table([description], descriptionFields, ['cms_page_description_id', 'cms_page_description_cms_page_id'], { cms_page_description_id: 'integer', cms_page_description_cms_page_id: 'integer' }, descriptionFields.filter(field => field !== 'content'));
  const before = seal(original);
  const after = migrated(before);
  const rewrite = { url_rewrite_id: 30, entity_uuid: 'synthetic-cms-uuid', entity_type: 'cms_page', request_path: '/synthetic-policy', target_path: '/page/synthetic-policy' };
  after.tables.urlRewrites = table([rewrite], rewriteFields, ['url_rewrite_id'], { url_rewrite_id: 'integer' }, rewriteFields);
  return { before, after: seal(after), rewrite, rewriteFields, description, descriptionFields };
}

test('CMS native additions require the original page UUID, slug and protected content hash', () => {
  const fixture = cmsFixture();
  const result = compareSnapshots(fixture.before, fixture.after);
  assert.equal(result.status, 'verified');
  assert.equal(result.nativeMappings.cmsPageRewritesAdded, 1);
  assert.equal(JSON.stringify(fixture.before.tables.cmsDescriptions).includes('Synthetic private merchant content'), false);
  const old = baseline();
  delete old.tables.cmsPages;
  delete old.tables.cmsDescriptions;
  assert.equal(compareSnapshots(seal(old), migrated()).mismatches.some(row => row.field === 'cmsRoutes.baseline_identity_or_path_missing'), true);
  const withoutContent = cmsFixture();
  withoutContent.before.tables.cmsDescriptions.columns = withoutContent.before.tables.cmsDescriptions.columns.filter(field => field !== 'content');
  assert.equal(compareSnapshots(seal(withoutContent.before), withoutContent.after).status, 'mismatch');
});

test('arbitrary CMS URLs, wrong UUID/type/target and unproven migration remain failures', () => {
  for (const change of [{ request_path: '/unrelated-route' }, { entity_uuid: 'unrelated-uuid' }, { entity_type: 'product' }, { target_path: '/unrelated-target' }]) {
    const fixture = cmsFixture();
    fixture.after.tables.urlRewrites = table([{ ...fixture.rewrite, ...change }], fixture.rewriteFields, ['url_rewrite_id'], { url_rewrite_id: 'integer' }, fixture.rewriteFields);
    assert.equal(compareSnapshots(fixture.before, seal(fixture.after)).status, 'mismatch');
  }
  const noProof = cmsFixture();
  noProof.after.nativeMigrations = noProof.after.nativeMigrations.filter(row => row.module !== 'cms');
  assert.equal(compareSnapshots(noProof.before, seal(noProof.after)).status, 'mismatch');
});

test('CMS additions cannot conceal a public path collision or changed original content', () => {
  const changedContent = cmsFixture();
  changedContent.after.tables.cmsDescriptions = table([{ ...changedContent.description, content: '<p>Changed merchant content</p>' }], changedContent.descriptionFields, ['cms_page_description_id', 'cms_page_description_cms_page_id'], { cms_page_description_id: 'integer', cms_page_description_cms_page_id: 'integer' }, changedContent.descriptionFields.filter(field => field !== 'content'));
  assert.equal(compareSnapshots(changedContent.before, seal(changedContent.after)).mismatches.some(row => row.field === 'cmsDescriptions.content'), true);
  const collision = cmsFixture();
  const oldRoute = { url_rewrite_id: 7, entity_uuid: 'synthetic-product-uuid', entity_type: 'product', request_path: '/synthetic-policy', target_path: '/product/synthetic-product' };
  collision.before.tables.urlRewrites = table([oldRoute], collision.rewriteFields, ['url_rewrite_id'], { url_rewrite_id: 'integer' }, collision.rewriteFields);
  collision.after.tables.urlRewrites = table([oldRoute, collision.rewrite], collision.rewriteFields, ['url_rewrite_id'], { url_rewrite_id: 'integer' }, collision.rewriteFields);
  assert.equal(compareSnapshots(seal(collision.before), seal(collision.after)).status, 'mismatch');
});
