import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildCatalogSnapshot, createCatalogImporter, validateCatalogSnapshot, retailUsd, safeDescription, readVerifiedImage, activateInventory, createCatalogFollower } from '../src/services/catalog.js';
import { UnknownMutationOutcomeError } from '../src/services/shopifyClient.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const anchorUuid = '10000000-0000-4000-8000-000000000001';
const secondUuid = '10000000-0000-4000-8000-000000000002';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XgnsAAAAASUVORK5CYII=', 'base64');
const imageHash = hash(png);
const image = { sha256: imageHash, localPath: `media/source-library/${imageHash}.png`, bytes: png.length, width: 1, height: 1, alt: 'Synthetic garment original' };
function fixture() {
  const style = { sourceId: 'L1001', sourceUuid: anchorUuid, handle: 'l1001', category: 'dresses', title: 'Synthetic Dress', descriptionHtml: '<p>Synthetic description</p>',
    seo: { title: 'Synthetic Dress', description: 'Synthetic only' }, canonicalPath: '/dresses/l1001', publishedAt: '2026-10-01T02:00:00Z', images: [image],
    variants: [{ uuid: anchorUuid, sku: 'SHUSHA-L1001', sourceVariantSku: 'SRC-RED-S', color: 'Red', size: 'S', sourceUsd: '10.00', retailUsd: '11.99', remainingCapacity: 17, imageHashes: [imageHash] },
      { uuid: secondUuid, sku: 'SHUSHA-L1001-V-SRC-BLUE-M', sourceVariantSku: 'SRC-BLUE-M', color: 'Blue', size: 'M', sourceUsd: '10.00', retailUsd: '11.99', remainingCapacity: -2, imageHashes: [imageHash] }] };
  return sign({ schemaVersion: 1, currency: 'USD', pricePolicy: 'source-resale-usd-times-1.1-ceiling-.99', capturedAt: '2026-10-10T01:00:00Z', styles: [style] });
}
function sign(snapshot) { const { contentSha256, ...value } = snapshot; return { ...value, contentSha256: hash(JSON.stringify(value)) }; }
function repository() {
  const products = new Map(); const media = new Map(); const operations = new Map();
  return { products, media, operations, async withLock(_, fn) { return fn(); },
    async getProduct(key) { return products.get(key); }, async saveProduct(key, value) { products.set(key, value); },
    async getMedia(key) { return media.get(key); }, async saveMedia(key, value) { media.set(key, value); },
    async getOperation(key) { return operations.get(key); }, async saveOperation(key, value) { operations.set(key, value); } };
}
function remote(style) {
  return { id: 'gid://shopify/Product/1001', handle: style.handle, status: 'DRAFT', metafield: { value: style.sourceUuid }, media: { nodes: [{ id: 'gid://shopify/MediaImage/1' }], pageInfo: { hasNextPage: false } }, variants: { pageInfo: { hasNextPage: false },
    nodes: style.variants.map((variant, index) => ({ id: `gid://shopify/ProductVariant/${index + 1}`, sku: variant.sku, price: variant.retailUsd,
      selectedOptions: [{ name: 'Color', value: variant.color }, { name: 'Size', value: variant.size }], inventoryItem: { id: `gid://shopify/InventoryItem/${index + 1}` }, media: { nodes: [{ id: 'gid://shopify/MediaImage/1' }], pageInfo: { hasNextPage: false } } })) } };
}
function fakeClient(snapshot, { currency = 'USD', dropDraft = false, failFile = false, processing = false, missingVariantMedia = false, dropActivation = false, dropPublish = false } = {}) {
  const calls = []; let product = null; let file = null; let stagedUploads = 0;
  const levels = new Map();
  return { calls, levels, get product() { return product; }, set product(value) { product = value; },
    async uploadStaged(_, bytes) { assert.deepEqual(bytes, png); stagedUploads++; calls.push({ operation: 'upload', bytes: bytes.length }); },
    async request(document, variables = {}, options = {}) {
      const operation = document.match(/(?:query|mutation)\s+(\w+)/)[1]; calls.push({ operation, variables, options, document });
      if (operation === 'BridgeCurrency') return { shop: { currencyCode: currency } };
      if (operation === 'BridgeProduct') return { productByIdentifier: product };
      if (operation === 'BridgeFiles') return { files: { nodes: file ? [file] : [] } };
      if (operation === 'BridgeStage') return { stagedUploadsCreate: { stagedTargets: [{ url: 'https://shopify-staged-uploads.storage.googleapis.com/', resourceUrl: 'https://storage.googleapis.com/synthetic-original', parameters: [] }], userErrors: [] } };
      if (operation === 'BridgeFile') { assert.equal(stagedUploads, 1); file = { id: 'gid://shopify/MediaImage/1', fileStatus: 'PROCESSING' }; return { fileCreate: { files: [file], userErrors: [] } }; }
      if (operation === 'BridgeFileStatus') return { node: { ...file, fileStatus: failFile ? 'FAILED' : processing ? 'PROCESSING' : 'READY', image: { url: 'https://cdn.shopify.com/synthetic.png' } } };
      if (operation === 'BridgeDraft') {
        assert.equal(variables.input.status, 'DRAFT'); assert.equal(file?.id, variables.input.files[0].id);
        assert.equal(variables.input.variants.length, 2); assert.equal('inventoryQuantities' in variables.input.variants[0], false); assert.equal('remainingCapacity' in variables.input.variants[0], false);
        assert.equal(variables.input.variants[0].file.id, file.id); assert.equal(variables.input.variants[0].price, '11.99');
        product = remote(snapshot.styles[0]); if (missingVariantMedia) product.variants.nodes[1].media.nodes = [];
        if (dropDraft) throw new UnknownMutationOutcomeError(); return { productSet: { product, userErrors: [] } };
      }
      if (operation === 'BridgeVariantMedia') return { nodes: variables.ids.map((id) => { const row = product.variants.nodes.find((variant) => variant.id === id); return { id, media: row.media }; }) };
      if (operation === 'BridgeVariantMediaAttach') {
        for (const association of variables.variantMedia) {
          const variant = product.variants.nodes.find((row) => row.id === association.variantId);
          variant.media.nodes.push(...association.mediaIds.map((id) => ({ id })));
        }
        return { productVariantAppendMedia: { product: { id: product.id }, userErrors: [] } };
      }
      if (operation === 'BridgePrices') {
        assert.deepEqual(Object.keys(variables).sort(), ['productId', 'variants']);
        for (const variant of variables.variants) { assert.deepEqual(Object.keys(variant).sort(), ['id', 'price']); product.variants.nodes.find((row) => row.id === variant.id).price = variant.price; }
        return { productVariantsBulkUpdate: { productVariants: variables.variants, userErrors: [] } };
      }
      if (operation === 'BridgeActivationRead') {
        const variant = product.variants.nodes.find((value) => value.inventoryItem.id === variables.id);
        return { inventoryItem: { id: variables.id, sku: variant.sku, tracked: true, variant: { id: variant.id, product: { id: product.id } }, inventoryLevel: levels.get(variables.id) || null } };
      }
      if (operation === 'BridgeActivate') {
        assert.match(document, /@idempotent\(key:\$key\)/); assert.equal(options.idempotencyKey, variables.key); assert.equal(options.safeRetry, true);
        assert.equal('available' in variables, false); assert.equal('onHand' in variables, false);
        const level = { id: `gid://shopify/InventoryLevel/${levels.size + 1}`, item: { id: variables.item }, location: { id: variables.location }, quantities: [{ name: 'available', quantity: 0 }] };
        levels.set(variables.item, level);
        if (dropActivation) throw new UnknownMutationOutcomeError();
        return { inventoryActivate: { inventoryLevel: level, userErrors: [] } };
      }
      if (operation === 'BridgePublication') return { product: { id: product.id, status: product.status, metafield: product.metafield, publishedOnPublication: product.publishedOnPublication === true } };
      if (operation === 'BridgeActivateProduct') {
        assert.deepEqual(Object.keys(variables.product).sort(), ['id', 'status']); product.status = 'ACTIVE'; return { productUpdate: { product: { id: product.id, status: product.status }, userErrors: [] } };
      }
      if (operation === 'BridgePublish') {
        product.publishedOnPublication = true;
        if (dropPublish) throw new UnknownMutationOutcomeError();
        return { publishablePublish: { userErrors: [] } };
      }
      throw new Error(`Unexpected synthetic operation ${operation}`);
    }
  };
}
async function originals(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-synthetic-original-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, `${imageHash}.png`), png); return root;
}

test('source USD reuses exact retail boundary rule; native editor HTML removes scripts, attributes and unsafe links', () => {
  assert.equal(retailUsd('0.90'), '0.99'); assert.equal(retailUsd('0.9001'), '1.99'); assert.equal(retailUsd('10'), '11.99'); assert.equal(retailUsd('9.99'), '10.99');
  assert.throws(() => retailUsd('0')); assert.throws(() => retailUsd('NaN'));
  const description = JSON.stringify([{ columns: [{ data: { blocks: [{ type: 'raw', data: { html: '<p onclick="bad()">Safe<script>unsafe()</script><a href="javascript:bad()">text</a></p>' } }] } }] }]);
  assert.equal(safeDescription(description), '<p>Safe<a>text</a></p>');
  assert.throws(() => safeDescription('[broken-json'), /invalid/);
});

test('private catalog tampering, duplicate true variants and price drift are refused before any transport', () => {
  const snapshot = fixture(); assert.equal(validateCatalogSnapshot(snapshot), snapshot);
  const altered = structuredClone(snapshot); altered.styles[0].variants[0].retailUsd = '10.00'; assert.throws(() => validateCatalogSnapshot(altered), /hash/);
  assert.throws(() => validateCatalogSnapshot(sign(altered)), /price\/image/);
  const duplicate = fixture(); duplicate.styles[0].variants[1].color = 'Red'; duplicate.styles[0].variants[1].size = 'S'; assert.throws(() => validateCatalogSnapshot(sign(duplicate)), /Duplicate real/);
});

test('original local media is hash verified and rejects changed bytes and path escape', async (t) => {
  const root = await originals(t); assert.deepEqual((await readVerifiedImage(image, root)).bytes, png);
  await assert.rejects(readVerifiedImage({ ...image, localPath: '../outside.png' }, root), /content-addressed/);
  await fs.writeFile(path.join(root, `${imageHash}.png`), Buffer.alloc(png.length));
  await assert.rejects(readVerifiedImage(image, root), /hash differs/);
});

test('draft import stages verified originals, waits READY, preserves variants/SKU/GIDs and repeat run does not recreate', async (t) => {
  const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot);
  const importer = createCatalogImporter({ client, mappingStore: repo, mediaRoot: await originals(t), sleep: async () => {} });
  assert.equal((await importer.importSnapshot(snapshot)).remoteWrites, false); assert.equal(client.calls.length, 0);
  const first = await importer.importSnapshot(snapshot, { apply: true }); assert.equal(first.draftsCreated, 1);
  assert.equal(repo.products.get(anchorUuid).variants[0].inventoryItemGid, 'gid://shopify/InventoryItem/1');
  const ready = client.calls.findIndex((row) => row.operation === 'BridgeFileStatus'); const draft = client.calls.findIndex((row) => row.operation === 'BridgeDraft'); assert.ok(ready < draft);
  const again = await importer.importSnapshot(snapshot, { apply: true }); assert.equal(again.draftsCreated, 0); assert.equal(client.calls.filter((row) => row.operation === 'BridgeDraft').length, 1);
  assert.equal(client.calls.filter((row) => row.operation === 'BridgeFile').length, 1);
});

test('daily catalog price followup uses only variant bulk prices and leaves native capacity/structure untouched', async (t) => {
  const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot); const importer = createCatalogImporter({ client, mappingStore: repo, mediaRoot: await originals(t) });
  await importer.importSnapshot(snapshot, { apply: true });
  const next = fixture(); next.styles[0].variants[0].sourceUsd = '11.00'; next.styles[0].variants[0].retailUsd = '12.99';
  assert.equal((await importer.importSnapshot(sign(next), { apply: true })).changedPrices, 1);
  assert.equal(client.calls.filter((row) => row.operation === 'BridgeDraft').length, 1); assert.equal(client.calls.filter((row) => row.operation === 'BridgePrices').length, 1);
  const changedStructure = fixture(); changedStructure.styles[0].variants[0].color = 'Pink';
  await assert.rejects(importer.importSnapshot(sign(changedStructure), { apply: true }), /options\/inventory ownership/);
});

test('all variant original-image associations are read back and missing association is added once', async (t) => {
  const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot, { missingVariantMedia: true });
  const importer = createCatalogImporter({ client, mappingStore: repo, mediaRoot: await originals(t) });
  await importer.importSnapshot(snapshot, { apply: true });
  assert.equal(client.calls.filter((row) => row.operation === 'BridgeVariantMediaAttach').length, 1);
  await importer.importSnapshot(snapshot, { apply: true }); assert.equal(client.calls.filter((row) => row.operation === 'BridgeVariantMediaAttach').length, 1);
  client.product.variants.nodes[0].media.nodes = [];
  await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /association changed/);
  assert.equal(client.calls.filter((row) => row.operation === 'BridgePrices').length, 0);
});

test('unknown draft outcome is durably recorded then recovered by owned handle without second creation', async (t) => {
  const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot, { dropDraft: true }); const importer = createCatalogImporter({ client, mappingStore: repo, mediaRoot: await originals(t) });
  await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), UnknownMutationOutcomeError);
  assert.equal(repo.operations.get(`draft-create:${anchorUuid}`).status, 'unknown'); assert.equal(repo.products.size, 0);
  const recovered = await importer.importSnapshot(snapshot, { apply: true }); assert.equal(recovered.draftsCreated, 0); assert.equal(repo.products.size, 1); assert.equal(client.calls.filter((row) => row.operation === 'BridgeDraft').length, 1);
});

test('unresolved draft absent on readback remains paused; currency, ownership and unready media block writes', async (t) => {
  const root = await originals(t); const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot);
  repo.operations.set(`draft-create:${anchorUuid}`, { status: 'unknown', inputHash: 'synthetic-prior-input-hash' });
  await assert.rejects(createCatalogImporter({ client, mappingStore: repo, mediaRoot: root }).importSnapshot(snapshot, { apply: true }), /Frozen.*differs|Unresolved/);
  assert.equal(client.calls.some((row) => row.operation === 'BridgeDraft'), false);
  const cny = fakeClient(snapshot, { currency: 'CNY' }); await assert.rejects(createCatalogImporter({ client: cny, mappingStore: repository(), mediaRoot: root }).importSnapshot(snapshot, { apply: true }), /currency to USD/); assert.equal(cny.calls.length, 1);
  const foreign = fakeClient(snapshot); foreign.product = { ...remote(snapshot.styles[0]), metafield: { value: secondUuid } };
  await assert.rejects(createCatalogImporter({ client: foreign, mappingStore: repository(), mediaRoot: root }).importSnapshot(snapshot, { apply: true }), /identity/);
  const unready = fakeClient(snapshot, { processing: true }); await assert.rejects(createCatalogImporter({ client: unready, mappingStore: repository(), mediaRoot: root, sleep: async () => {} }).importSnapshot(snapshot, { apply: true }), /not READY/); assert.equal(unready.calls.some((row) => row.operation === 'BridgeDraft'), false);
});

test('production exporter selects only completed published reviewed actual variants, preserves negative capacity and never reads orders', async (t) => {
  const root = await originals(t); const snapshot = fixture(); const style = snapshot.styles[0]; const queries = [];
  const plan = { sourceId: style.sourceId, category: style.category, review: { ready: true, reviewedAt: '2026-10-01T01:00:00Z', reviewedSourceSha256: 'a'.repeat(64) }, variants: style.variants.map((variant) => ({ ...variant, storeSku: variant.sku, images: [{ ...image, assetUrl: `/assets/source-library/${imageHash}.png` }] })) };
  const products = style.variants.map((variant, index) => ({ product_id: index + 1, uuid: variant.uuid, sku: variant.sku, price: variant.sourceUsd, variant_group_id: 1, visibility: index === 0, status: true, created_at: style.publishedAt,
    name: style.title, description: style.descriptionHtml, url_key: index === 0 ? style.handle : 'l1001-v-src-blue-m', meta_title: style.title, meta_description: 'Synthetic only', qty: variant.remainingCapacity }));
  const storeMap = { schemaVersion: 1, mappings: style.variants.map((variant, index) => ({ sourceId: style.sourceId, sourceVariantSku: variant.sourceVariantSku, storeSku: variant.sku, storeUrlKey: products[index].url_key, priceBasis: 'site-resale-display' })) };
  const db = { async query(sql, params) {
    queries.push(sql);
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.startsWith('SELECT source_id')) return { rows: [{ source_id: style.sourceId, anchor_sku: style.variants[0].sku, group_id: 1, plan, created_at: style.publishedAt }] };
    if (sql.startsWith('SELECT p.product_id')) return { rows: products };
    if (sql.startsWith('SELECT v.product_id')) return { rows: style.variants.flatMap((variant, index) => [{ product_id: index + 1, attribute_code: 'shusha_color', option_text: variant.color }, { product_id: index + 1, attribute_code: 'shusha_size', option_text: variant.size }]) };
    if (sql.startsWith('SELECT product_image')) return { rows: products.map((row) => ({ product_image_product_id: row.product_id, origin_image: `/assets/source-library/${imageHash}.png`, is_main: true })) };
    return { rows: [] };
  } };
  const exported = await buildCatalogSnapshot({ db, storeMap, mediaIndex: { schemaVersion: 1, assets: [image] }, mediaRoot: root, now: () => new Date(snapshot.capturedAt) });
  assert.equal(exported.styles.length, 1); assert.equal(exported.styles[0].variants[1].remainingCapacity, -2); validateCatalogSnapshot(exported);
  assert.equal(queries.some((sql) => /\b(customer|order|SELECT\s+\*)\b/i.test(sql.replace(/ORDER BY/g, ''))), false);
  assert.equal(queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), true); assert.equal(queries.includes('COMMIT'), true);
  plan.review.ready = false;
  await assert.rejects(buildCatalogSnapshot({ db, storeMap, mediaIndex: { schemaVersion: 1, assets: [image] }, mediaRoot: root }), /visual review/);
  assert.equal(queries.includes('ROLLBACK'), true);
});

test('explicit inventory activation creates zero-level once with persisted idempotency and never overwrites existing quantity', async (t) => {
  const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot); const root = await originals(t);
  await createCatalogImporter({ client, mappingStore: repo, mediaRoot: root }).importSnapshot(snapshot, { apply: true });
  const options = { mappingStore: repo, client, locationId: 'gid://shopify/Location/1', styles: snapshot.styles, apply: true };
  const result = await activateInventory(options); assert.equal(result.activated, 2); assert.equal(result.capacityWritten, false);
  client.levels.get('gid://shopify/InventoryItem/1').quantities[0].quantity = 17;
  assert.equal((await activateInventory(options)).alreadyActive, 2);
  assert.equal(client.levels.get('gid://shopify/InventoryItem/1').quantities[0].quantity, 17);
  assert.equal(client.calls.filter((row) => row.operation === 'BridgeActivate').length, 2);
  client.product.status = 'ACTIVE'; await assert.rejects(activateInventory(options), /managed drafts/);
});

test('lost inventory activation response reconciles original level without second call; expired intent never starts a new key', async (t) => {
  const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot, { dropActivation: true }); const root = await originals(t);
  await createCatalogImporter({ client, mappingStore: repo, mediaRoot: root }).importSnapshot(snapshot, { apply: true });
  const options = { mappingStore: repo, client, locationId: 'gid://shopify/Location/1', styles: snapshot.styles, apply: true, now: () => Date.parse('2026-10-10T02:00:00Z') };
  await assert.rejects(activateInventory(options), UnknownMutationOutcomeError);
  const key = 'inventory-activate:gid://shopify/InventoryItem/1:gid://shopify/Location/1'; const saved = repo.operations.get(key); assert.equal(saved.status, 'unknown');
  // Second SKU remains unresolved, so recovery reaches it and fails there once.
  await assert.rejects(activateInventory(options), UnknownMutationOutcomeError);
  assert.equal(repo.operations.get(key).status, 'complete'); assert.equal(client.calls.filter((row) => row.operation === 'BridgeActivate' && row.variables.item.endsWith('/1')).length, 1);
  const second = 'inventory-activate:gid://shopify/InventoryItem/2:gid://shopify/Location/1'; client.levels.delete('gid://shopify/InventoryItem/2');
  const old = repo.operations.get(second); repo.operations.set(second, { ...old, firstSentAt: '2026-10-08T02:00:00Z' });
  await assert.rejects(activateInventory(options), /idempotency window/); assert.equal(repo.operations.get(second).idempotencyKey, old.idempotencyKey); assert.equal(repo.operations.get(second).status, 'attention');
});

test('minute catalog follower imports published source as DRAFT, waits explicit payment/capacity barrier and publishes once', async (t) => {
  const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot); let ready = false; const root = await originals(t);
  const env = { SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_BRIDGE_WRITES_ENABLED: 'true', MATERIAL_MEDIA_DIR: root, SHOPIFY_CATALOG_PUBLICATION_ENABLED: 'true', SHOPIFY_SHARED_CAPACITY_ENABLED: 'true', SHOPIFY_PAYMENT_OPERATIONS_ENABLED: 'true', SHOPIFY_LOCATION_ID: 'gid://shopify/Location/1', SHOPIFY_PUBLICATION_ID: 'gid://shopify/Publication/1' };
  const follower = createCatalogFollower({ client, repositories: { mappings: repo } }, { env, snapshotProvider: async () => snapshot, readinessProvider: async () => ready });
  assert.equal((await follower()).draftsCreated, 1); assert.equal(client.product.status, 'DRAFT'); assert.equal(client.product.publishedOnPublication, undefined);
  ready = true; env.SHOPIFY_PAYMENT_OPERATIONS_ENABLED = 'false'; assert.equal((await follower()).publicationPaused, true); assert.equal(client.product.status, 'DRAFT');
  env.SHOPIFY_PAYMENT_OPERATIONS_ENABLED = 'true'; assert.equal((await follower()).published, 1); assert.equal(client.product.status, 'ACTIVE');
  assert.equal((await follower()).published, 0); assert.equal(client.calls.filter((row) => row.operation === 'BridgeDraft').length, 1); assert.equal(client.calls.filter((row) => row.operation === 'BridgePublish').length, 1);
  env.SHOPIFY_BRIDGE_WRITES_ENABLED = 'false'; const count = client.calls.length; assert.equal((await follower()).status, 'paused'); assert.equal(client.calls.length, count);
});

test('lost publication response journals unknown then readback resolves ownership without publishing twice', async (t) => {
  const snapshot = fixture(); const repo = repository(); const client = fakeClient(snapshot, { dropPublish: true }); const root = await originals(t);
  const env = { SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_BRIDGE_WRITES_ENABLED: 'true', MATERIAL_MEDIA_DIR: root, SHOPIFY_CATALOG_PUBLICATION_ENABLED: 'true', SHOPIFY_SHARED_CAPACITY_ENABLED: 'true', SHOPIFY_PAYMENT_OPERATIONS_ENABLED: 'true', SHOPIFY_LOCATION_ID: 'gid://shopify/Location/1', SHOPIFY_PUBLICATION_ID: 'gid://shopify/Publication/1' };
  const follower = createCatalogFollower({ client, repositories: { mappings: repo } }, { env, snapshotProvider: async () => snapshot, readinessProvider: async () => true });
  await assert.rejects(follower(), UnknownMutationOutcomeError); const key = 'product-publish:gid://shopify/Product/1001:gid://shopify/Publication/1'; assert.equal(repo.operations.get(key).status, 'unknown');
  assert.equal((await follower()).published, 0); assert.equal(repo.operations.get(key).status, 'complete'); assert.equal(client.calls.filter((row) => row.operation === 'BridgePublish').length, 1);
});
