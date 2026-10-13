import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getAjv } from '../../packages/evershop/src/modules/base/services/getAjv.js';
import { createDescriptionPreservingUpdate, descriptionRows } from '../lib/material-catalog.mjs';

// Use the native validator and its actual description default, rather than a
// hand-written validator that would miss the destructive partial-update path.
const productSchema = JSON.parse(await readFile(new URL(
  '../../packages/evershop/src/modules/catalog/services/product/productDataSchema.json', import.meta.url
), 'utf8'));
const createRequired = ['name', 'url_key', 'status', 'sku', 'qty', 'price', 'group_id', 'visibility'];

function nativeValidation(required) {
  const validate = getAjv().compile({ ...structuredClone(productSchema), required });
  return data => assert.equal(validate(data), true, JSON.stringify(validate.errors));
}

function fixture({ parsedDescription = false } = {}) {
  let product;
  let descriptionReads = 0;
  const updates = [];
  const validateCreate = nativeValidation(createRequired);
  const validateUpdate = nativeValidation([]);
  const pool = { async query(sql, parameters) {
    assert.match(sql, /SELECT d\.description FROM product p JOIN product_description d/);
    assert.deepEqual(parameters, ['synthetic-product-uuid']);
    descriptionReads += 1;
    return { rows: product ? [{ description: parsedDescription
      ? JSON.parse(product.description) : product.description }] : [] };
  } };
  const createProduct = async data => {
    validateCreate(data);
    product = { ...structuredClone(data), uuid: 'synthetic-product-uuid',
      description: JSON.stringify(data.description) };
  };
  const updateProduct = async (uuid, data, context) => {
    assert.equal(uuid, product.uuid);
    validateUpdate(data);
    updates.push(structuredClone(data));
    // Native updateProduct persists validated fields into product_description;
    // its AJV-injected [] therefore really replaces the previous JSON copy.
    product = { ...product, ...structuredClone(data), description: JSON.stringify(data.description) };
    return { ...product, context };
  };
  return { createProduct, nativeUpdate: updateProduct,
    update: createDescriptionPreservingUpdate(pool, updateProduct),
    get product() { return product; }, get descriptionReads() { return descriptionReads; }, updates };
}

function createPayload() {
  return { name: 'Synthetic dress', url_key: 'l1001', status: 0, visibility: 0,
    sku: 'SHUSHA-L1001-WHITE-M', qty: 997, price: 4.25, group_id: 1,
    category_id: 2, tax_class: 1,
    description: descriptionRows('<p>Synthetic garment. Availability is confirmed before payment.</p>') };
}

test('native 2.2.1 AJV defaults erase omitted copy without the publisher adapter', async () => {
  const f = fixture();
  await f.createProduct(createPayload());
  assert.notDeepEqual(JSON.parse(f.product.description), []);
  await f.nativeUpdate(f.product.uuid, { status: 1, visibility: 0, category_id: 2, tax_class: 1 });
  assert.deepEqual(JSON.parse(f.product.description), []);
});

for (const parsedDescription of [false, true]) {
  test(`create → enable → visible anchor preserves copy with ${parsedDescription ? 'parsed' : 'JSON-text'} DB rows`, async () => {
    const f = fixture({ parsedDescription });
    const created = createPayload();
    await f.createProduct(created);
    const originalDescription = structuredClone(created.description);
    const enable = Object.freeze({ status: 1, visibility: 0, category_id: 2, tax_class: 1 });
    const anchor = Object.freeze({ status: 1, visibility: 1, category_id: 2, tax_class: 1 });
    await f.update(f.product.uuid, enable);
    assert.deepEqual(JSON.parse(f.product.description), originalDescription);
    await f.update(f.product.uuid, anchor);
    assert.deepEqual(JSON.parse(f.product.description), originalDescription);
    assert.equal(f.product.status, 1);
    assert.equal(f.product.visibility, 1);
    assert.equal(f.product.price, 4.25);
    assert.equal(f.product.qty, 997);
    assert.equal(f.descriptionReads, 2);
    for (const payload of f.updates) {
      assert.equal(Object.hasOwn(payload, 'price'), false);
      assert.equal(Object.hasOwn(payload, 'qty'), false);
    }
    assert.equal(Object.hasOwn(enable, 'description'), false);
    assert.equal(Object.hasOwn(anchor, 'description'), false);
  });
}

test('explicit empty description still clears copy and stays empty on later partial updates', async () => {
  const f = fixture();
  await f.createProduct(createPayload());
  const clear = Object.freeze({ description: Object.freeze([]), category_id: 2, tax_class: 1 });
  await f.update(f.product.uuid, clear);
  assert.deepEqual(JSON.parse(f.product.description), []);
  assert.equal(f.descriptionReads, 0);
  assert.deepEqual(clear.description, []);
  await f.update(f.product.uuid, { visibility: 1, category_id: 2, tax_class: 1 });
  assert.deepEqual(JSON.parse(f.product.description), []);
});

test('undefined description preserves existing copy without altering the caller property', async () => {
  const f = fixture();
  await f.createProduct(createPayload());
  const originalDescription = JSON.parse(f.product.description);
  const data = Object.freeze({ description: undefined, status: 1, category_id: 2, tax_class: 1 });
  await f.update(f.product.uuid, data);
  assert.deepEqual(JSON.parse(f.product.description), originalDescription);
  assert.equal(Object.hasOwn(data, 'description'), true);
  assert.equal(data.description, undefined);
});

test('explicit replacement is copied, native result and context are forwarded', async () => {
  const description = descriptionRows('<p>Synthetic replacement</p>');
  const data = { description, attributes: [{ attribute_code: 'synthetic', value: ['M'] }] };
  const original = structuredClone(data);
  const context = { syntheticOperation: true };
  const result = { syntheticResult: true };
  const update = createDescriptionPreservingUpdate({ async query() { throw new Error('Unexpected lookup'); } },
    async (uuid, payload, receivedContext) => {
      assert.equal(uuid, 'synthetic-product-uuid');
      assert.equal(receivedContext, context);
      payload.description[0].columns[0].data.blocks[0].data.html = '<p>Sanitized copy</p>';
      payload.attributes[0].value.push('L');
      return result;
    });
  assert.equal(await update('synthetic-product-uuid', data, context), result);
  assert.deepEqual(data, original);
});

test('missing product description stops before a native write', async () => {
  const update = createDescriptionPreservingUpdate({ async query() { return { rows: [] }; } },
    async () => assert.fail('Unexpected write'));
  await assert.rejects(update('synthetic-product-uuid', { visibility: 1 }), /description is unresolved/);
});

test('malformed stored copy stops before a native write instead of silently erasing it', async () => {
  for (const description of ['{invalid-json', '{}', 'null', '[{"id":"row","size":1}]',
    '[{"id":"row","size":1,"columns":[{"id":"col","size":1,"data":[]}]}]']) {
    const update = createDescriptionPreservingUpdate({ async query() { return { rows: [{ description }] }; } },
      async () => assert.fail('Unexpected write'));
    await assert.rejects(update('synthetic-product-uuid', { visibility: 1 }), /Stored material description/);
  }
});
