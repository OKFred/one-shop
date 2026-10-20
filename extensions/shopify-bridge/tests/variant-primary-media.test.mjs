import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { createCatalogImporter } from '../src/services/catalog.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const productId = 'gid://shopify/Product/1001';
const sourceUuid = '10000000-0000-4000-8000-000000000001';
const now = () => Date.parse('2026-10-20T02:00:00Z');
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;

// Distinct valid originals, including PNG chunk CRCs, avoid testing a gallery
// assembled by appending arbitrary bytes to a single image.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
function originalPng(index) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, index + 1, 31 + index, 91 + index]))), pngChunk('IEND', Buffer.alloc(0))]);
}
function fixture(count = 9) {
  const originals = Array.from({ length: count }, (_, index) => originalPng(index));
  const images = originals.map((bytes, index) => ({ sha256: hash(bytes), bytes: bytes.length,
    localPath: `media/source-library/${hash(bytes)}.png`, width: 1, height: 1, alt: `Synthetic original ${index + 1}` }));
  const hashes = images.map((image) => image.sha256);
  const style = { sourceId: 'L1001', sourceUuid, handle: 'l1001', category: 'dresses', title: 'Synthetic multi-image dress',
    descriptionHtml: '<p>Synthetic gallery fixture</p>', seo: { title: 'Synthetic', description: 'Synthetic only' },
    canonicalPath: '/dresses/l1001', publishedAt: '2026-10-20T02:00:00Z', images,
    variants: [{ uuid: sourceUuid, sku: 'SHUSHA-L1001', sourceVariantSku: 'RED-S', color: 'Red', size: 'S',
      sourceUsd: '10.00', retailUsd: '15.99', remainingCapacity: 17, imageHashes: hashes },
    { uuid: '10000000-0000-4000-8000-000000000002', sku: 'SHUSHA-L1001-V-BLUE-M', sourceVariantSku: 'BLUE-M', color: 'Blue', size: 'M',
      sourceUsd: '10.00', retailUsd: '15.99', remainingCapacity: -2, imageHashes: [...hashes.slice(1), hashes[0]] }] };
  const unsigned = { schemaVersion: 1, currency: 'USD', pricePolicy: 'source-resale-usd-times-1.5-ceiling-.99',
    capturedAt: '2026-10-20T02:00:00Z', styles: [style] };
  return { snapshot: { ...unsigned, contentSha256: hash(JSON.stringify(unsigned)) }, style, originals };
}
function structuralHash(style) {
  return hash(JSON.stringify({ sourceUuid: style.sourceUuid, handle: style.handle, category: style.category, title: style.title,
    descriptionHtml: style.descriptionHtml,
    variants: style.variants.map(({ uuid, sku, color, size, imageHashes }) => ({ uuid, sku, color, size, imageHashes })),
    images: style.images.map(({ sha256 }) => sha256) }));
}
const mediaGid = (style, sha256) => `gid://shopify/MediaImage/${style.images.findIndex((image) => image.sha256 === sha256) + 1}`;
const variantGid = (index) => `gid://shopify/ProductVariant/${index + 1}`;
function remote(style, missing = []) {
  return { id: productId, handle: style.handle, status: 'DRAFT', metafield: { value: style.sourceUuid },
    media: { nodes: style.images.map((image) => ({ id: mediaGid(style, image.sha256) })), pageInfo: { hasNextPage: false } },
    variants: { pageInfo: { hasNextPage: false }, nodes: style.variants.map((variant, index) => ({ id: variantGid(index),
      sku: variant.sku, price: variant.retailUsd, inventoryItem: { id: `gid://shopify/InventoryItem/${index + 1}` },
      selectedOptions: [{ name: 'Color', value: variant.color }, { name: 'Size', value: variant.size }],
      media: { nodes: missing.includes(index) ? [] : [{ id: mediaGid(style, variant.imageHashes[0]) }], pageInfo: { hasNextPage: false } } })),
    } };
}
function repository() {
  const products = new Map(), media = new Map(), operations = new Map(), saves = [];
  return { products, media, operations, saves, async withLock(_, fn) { return fn(); },
    async getProduct(key) { return structuredClone(products.get(key)); },
    async saveProduct(key, value) { saves.push({ kind: 'product', key }); products.set(key, structuredClone(value)); },
    async getMedia(key) { return structuredClone(media.get(key)); },
    async saveMedia(key, value) { saves.push({ kind: 'media', key }); media.set(key, structuredClone(value)); },
    async getOperation(key) { return structuredClone(operations.get(key)); },
    async saveOperation(key, value) { saves.push({ kind: 'operation', key }); operations.set(key, structuredClone(value)); } };
}
function clientFor({ style, originals }, { existing = false, missing = [], partialAttachFailure = false, ignoreAttach = false, corruptAttachReadback = null } = {}) {
  const calls = [], files = new Map(), uploaded = new Map();
  let product = existing ? remote(style, missing) : null;
  if (existing) style.images.forEach((image) => files.set(mediaGid(style, image.sha256), {
    id: mediaGid(style, image.sha256), fileStatus: 'READY', filename: `shusha-${image.sha256}.png` }));
  const client = { calls, files, get product() { return product; },
    async uploadStaged(target, bytes, original) {
      const index = style.images.findIndex((image) => original.filename === `shusha-${image.sha256}.png`);
      assert.ok(index >= 0); assert.deepEqual(bytes, originals[index]);
      uploaded.set(target.resourceUrl, index); calls.push({ operation: 'upload', mutation: true });
    },
    async request(document, variables = {}, options = {}) {
      const operation = document.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      calls.push({ operation, variables: structuredClone(variables), mutation: options.kind === 'mutation' });
      if (operation === 'BridgeCurrency') return { shop: { currencyCode: 'USD' } };
      if (operation === 'BridgeProduct') return { productByIdentifier: structuredClone(product) };
      if (operation === 'BridgeGlobalSku') return { productVariants: { nodes: product ? product.variants.nodes.map((variant) => ({
        id: variant.id, sku: variant.sku, product: { id: product.id, handle: product.handle }
      })) : [], pageInfo: { hasNextPage: false, endCursor: null } } };
      if (operation === 'BridgeFiles') {
        const filename = variables.query.match(/^filename:"([^"]+)"$/)?.[1];
        return { files: { nodes: [...files.values()].filter((file) => file.filename === filename).map((file) => structuredClone(file)) } };
      }
      if (operation === 'BridgeStage') {
        const index = style.images.findIndex((image) => variables.input[0].filename === `shusha-${image.sha256}.png`);
        assert.ok(index >= 0);
        return { stagedUploadsCreate: { stagedTargets: [{ url: 'https://shopify-staged-uploads.storage.googleapis.com/',
          resourceUrl: `https://storage.googleapis.com/synthetic/${index}`, parameters: [] }], userErrors: [] } };
      }
      if (operation === 'BridgeFile') {
        assert.equal(variables.files.length, 1);
        const index = uploaded.get(variables.files[0].originalSource); assert.notEqual(index, undefined);
        const id = mediaGid(style, style.images[index].sha256);
        const file = { id, fileStatus: 'READY', filename: variables.files[0].filename }; files.set(id, file);
        return { fileCreate: { files: [structuredClone(file)], userErrors: [] } };
      }
      if (operation === 'BridgeFileStatus') return { node: { ...files.get(variables.id), image: { url: 'https://cdn.shopify.com/synthetic.png' } } };
      if (operation === 'BridgeDraft') {
        const expected = style.images.map((image) => ({ id: mediaGid(style, image.sha256) }));
        assert.deepEqual(variables.input.files, expected, 'productSet keeps every original in gallery order');
        assert.equal(variables.input.status, 'DRAFT'); assert.equal(variables.input.variants.length, style.variants.length);
        for (const [index, variant] of variables.input.variants.entries()) {
          assert.deepEqual(variant.file, { id: mediaGid(style, style.variants[index].imageHashes[0]) });
          assert.equal('inventoryQuantities' in variant, false); assert.equal('remainingCapacity' in variant, false);
        }
        product = remote(style, missing);
        return { productSet: { product: structuredClone(product), userErrors: [] } };
      }
      if (operation === 'BridgeVariantMedia') return { nodes: variables.ids.map((id) => {
        const variant = product.variants.nodes.find((row) => row.id === id);
        return variant ? { id, media: structuredClone(variant.media) } : null;
      }) };
      if (operation === 'BridgeVariantMediaAttach') {
        const seen = new Set(), userErrors = [];
        for (const [index, pair] of variables.variantMedia.entries()) {
          const variant = product.variants.nodes.find((row) => row.id === pair.variantId);
          const invalid = !variant || pair.mediaIds.length !== 1 || seen.has(pair.variantId);
          if (invalid) { userErrors.push({ field: ['variantMedia', String(index)], code: 'INVALID_MEDIA_INPUT' }); continue; }
          seen.add(pair.variantId);
          if (variant.media.nodes.length) { userErrors.push({ field: ['variantMedia', String(index)], code: 'PRODUCT_VARIANT_ALREADY_HAS_MEDIA' }); continue; }
          if (partialAttachFailure && index > 0) { userErrors.push({ field: ['variantMedia', String(index)], code: 'SYNTHETIC_PARTIAL_FAILURE' }); continue; }
          if (!ignoreAttach) variant.media.nodes = pair.mediaIds.map((id) => ({ id }));
          if (corruptAttachReadback === 'wrong') variant.media.nodes = [{ id: 'gid://shopify/MediaImage/999999' }];
          if (corruptAttachReadback === 'duplicate') variant.media.nodes.push(...structuredClone(variant.media.nodes));
        }
        return { productVariantAppendMedia: { product: { id: product.id }, userErrors } };
      }
      if (operation === 'BridgePrices') throw new Error('Correct prices must not be rewritten by primary-image recovery');
      throw new Error(`Unexpected synthetic operation ${operation}`);
    } };
  return client;
}
async function setup(t, count = 9, options = {}) {
  const data = fixture(count), repo = repository(), client = clientFor(data, options);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-primary-media-synthetic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [index, image] of data.style.images.entries()) await fs.writeFile(path.join(root, `${image.sha256}.png`), data.originals[index]);
  if (options.existing) data.style.images.forEach((image) => repo.media.set(image.sha256, {
    gid: mediaGid(data.style, image.sha256), sha256: image.sha256, filename: `shusha-${image.sha256}.png` }));
  return { ...data, repo, client, importer: createCatalogImporter({ client, mappingStore: repo, mediaRoot: root, now, sleep: async () => {} }) };
}
function legacyFailed(style) {
  const input = style.variants.map((variant, index) => ({ variantId: variantGid(index),
    mediaIds: variant.imageHashes.slice(1).map((value) => mediaGid(style, value)) }));
  return { input, inputHash: hash(JSON.stringify(input)), status: 'failed', errorCode: 'SHOPIFY_CATALOG_FAILED',
    sentAt: '2026-10-20T01:59:00.000Z', diagnostic: { category: 'synthetic-only', requestOrdinal: 1 } };
}
function keys(style) {
  const structure = structuralHash(style);
  return { legacy: `variant-media:${style.sourceUuid}:${structure}`, primary: `variant-primary-media:${style.sourceUuid}:${structure}` };
}
const mutations = (client) => client.calls.filter((call) => call.mutation);
const expectedPrimaries = (style) => style.variants.map((variant, index) => ({ variantId: variantGid(index), mediaId: mediaGid(style, variant.imageHashes[0]) }));

for (const count of [9, 7]) {
  test(`${count} verified originals stay in the product gallery while each variant has only its first source image`, async (t) => {
    const { snapshot, style, originals, repo, client, importer } = await setup(t, count);
    assert.equal(new Set(originals.map(hash)).size, count);
    for (const bytes of originals) {
      assert.deepEqual(inflateSync(bytes.subarray(41, bytes.length - 16)), Buffer.from([0, originals.indexOf(bytes) + 1, 31 + originals.indexOf(bytes), 91 + originals.indexOf(bytes)]));
    }
    const result = await importer.importSnapshot(snapshot, { apply: true });
    assert.equal(result.draftsCreated, 1);
    assert.deepEqual(client.product.media.nodes.map((node) => node.id), style.images.map((image) => mediaGid(style, image.sha256)));
    assert.deepEqual(client.product.variants.nodes.map((variant) => variant.media.nodes),
      style.variants.map((variant) => [{ id: mediaGid(style, variant.imageHashes[0]) }]));
    assert.equal(client.calls.filter((call) => call.operation === 'BridgeVariantMediaAttach').length, 0);
    assert.equal(repo.products.size, 1);
    assert.deepEqual(repo.products.get(sourceUuid).variants.map((variant) => variant.imageHashes), style.variants.map((variant) => variant.imageHashes));
    const writeCount = mutations(client).length;
    assert.equal((await importer.importSnapshot(snapshot, { apply: true })).draftsCreated, 0);
    assert.equal(mutations(client).length, writeCount);
  });
}

test('an owned DRAFT with an old full-gallery failure recovers mapping with zero provider writes and a separate resolution', async (t) => {
  const { snapshot, style, repo, client, importer } = await setup(t, 9, { existing: true });
  const operationKeys = keys(style), old = legacyFailed(style);
  // Exercise PostgreSQL JSONB object-key order without changing array order.
  old.input = old.input.map(({ variantId, mediaIds }) => ({ mediaIds, variantId }));
  repo.operations.set(operationKeys.legacy, structuredClone(old));
  const oldBytes = JSON.stringify(old);
  assert.equal((await importer.importSnapshot(snapshot, { apply: true })).draftsCreated, 0);
  assert.equal(mutations(client).length, 0); assert.equal(repo.products.size, 1);
  assert.equal(JSON.stringify(repo.operations.get(operationKeys.legacy)), oldBytes);
  const resolutionKey = `variant-media-resolution:${sourceUuid}:${old.inputHash}`;
  const expected = { kind: 'variant-primary-media-resolution', status: 'complete', policy: 'single-primary-image-v1', sourceUuid,
    productGid: productId, structureSha256: structuralHash(style), originalOperationKey: operationKeys.legacy,
    originalInputHash: old.inputHash, originalStatus: 'failed', originalRecordSha256: hash(JSON.stringify(stable(old))),
    primaryReadback: expectedPrimaries(style), resolvedAt: new Date(now()).toISOString() };
  assert.deepEqual(repo.operations.get(resolutionKey), expected);
  assert.equal(repo.operations.has(operationKeys.primary), false);
  const saves = repo.saves.filter((save) => save.kind !== 'media');
  assert.deepEqual(saves, [{ kind: 'operation', key: resolutionKey }, { kind: 'product', key: sourceUuid }]);
  await importer.importSnapshot(snapshot, { apply: true });
  assert.equal(mutations(client).length, 0);
  assert.equal(JSON.stringify(repo.operations.get(operationKeys.legacy)), oldBytes);
  assert.deepEqual(repo.operations.get(resolutionKey), expected);
  assert.deepEqual(repo.saves.filter((save) => save.kind !== 'media'), saves);
});

for (const keyType of ['legacy', 'primary']) for (const status of ['sent', 'unknown']) {
  test(`${keyType} ${status} intent remains unresolved even when current primary images match`, async (t) => {
    const { snapshot, style, repo, client, importer } = await setup(t, 7, { existing: true });
    const key = keys(style)[keyType], original = { ...legacyFailed(style), status };
    repo.operations.set(key, structuredClone(original));
    await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /Unresolved|unresolved/);
    assert.equal(mutations(client).length, 0); assert.equal(repo.products.size, 0);
    assert.deepEqual(repo.operations.get(key), original);
    assert.equal(repo.saves.some((save) => save.kind === 'operation' || save.kind === 'product'), false);
  });
}

for (const corruption of ['hash', 'foreign-media', 'duplicate-variant', 'extra-field', 'missing-input']) {
  test(`malformed old failed intent (${corruption}) cannot receive a resolution or product mapping`, async (t) => {
    const { snapshot, style, repo, client, importer } = await setup(t, 9, { existing: true });
    const old = legacyFailed(style);
    if (corruption === 'hash') old.inputHash = '0'.repeat(64);
    if (corruption === 'foreign-media') old.input[0].mediaIds = ['gid://shopify/MediaImage/999999'];
    if (corruption === 'duplicate-variant') old.input[1].variantId = old.input[0].variantId;
    if (corruption === 'extra-field') old.input[0].unexpected = true;
    if (corruption === 'missing-input') delete old.input;
    repo.operations.set(keys(style).legacy, structuredClone(old));
    await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /Legacy failed|Legacy variant-media|Legacy.*hash/);
    assert.equal(mutations(client).length, 0); assert.equal(repo.products.size, 0);
    assert.deepEqual(repo.operations.get(keys(style).legacy), old);
    assert.equal(repo.saves.some((save) => save.kind === 'operation' || save.kind === 'product'), false);
  });
}

test('a missing primary association appends one ID once, then verifies fresh readback before mapping', async (t) => {
  const { snapshot, style, repo, client, importer } = await setup(t, 7, { existing: true, missing: [1] });
  await importer.importSnapshot(snapshot, { apply: true });
  const attached = client.calls.filter((call) => call.operation === 'BridgeVariantMediaAttach');
  const input = [{ variantId: variantGid(1), mediaIds: [mediaGid(style, style.variants[1].imageHashes[0])] }];
  assert.equal(attached.length, 1); assert.deepEqual(attached[0].variables, { productId, variantMedia: input });
  assert.equal(repo.operations.get(keys(style).primary).inputHash, hash(JSON.stringify(input)));
  assert.equal(repo.operations.get(keys(style).primary).status, 'complete');
  assert.ok(client.calls.findIndex((call) => call.operation === 'BridgeVariantMediaAttach') <
    client.calls.findLastIndex((call) => call.operation === 'BridgeVariantMedia'));
  assert.equal(repo.products.size, 1);
  await importer.importSnapshot(snapshot, { apply: true });
  assert.equal(client.calls.filter((call) => call.operation === 'BridgeVariantMediaAttach').length, 1);
});

test('an acknowledged association without matching readback never creates the product mapping', async (t) => {
  const { snapshot, style, repo, client, importer } = await setup(t, 7, { existing: true, missing: [1], ignoreAttach: true });
  await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /primary-image readback differs/);
  assert.equal(client.calls.filter((call) => call.operation === 'BridgeVariantMediaAttach').length, 1);
  assert.equal(repo.products.size, 0); assert.equal(repo.operations.get(keys(style).primary).status, 'failed');
});

for (const corruption of ['wrong', 'duplicate']) {
  test(`acknowledged association with ${corruption} primary readback remains failed and preserves the legacy record`, async (t) => {
    const { snapshot, style, repo, client, importer } = await setup(t, 7, { existing: true, missing: [1], corruptAttachReadback: corruption });
    const operationKeys = keys(style), legacy = legacyFailed(style);
    repo.operations.set(operationKeys.legacy, structuredClone(legacy));
    await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /primary image differs|unrelated\/unbounded/);
    assert.equal(client.calls.filter((call) => call.operation === 'BridgeVariantMediaAttach').length, 1);
    assert.equal(repo.products.size, 0); assert.deepEqual(repo.operations.get(operationKeys.legacy), legacy);
    const failed = repo.operations.get(operationKeys.primary);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.input, [{ variantId: variantGid(1), mediaIds: [mediaGid(style, style.variants[1].imageHashes[0])] }]);
    assert.equal(failed.inputHash, hash(JSON.stringify(failed.input)));
    assert.equal(repo.operations.has(`variant-media-resolution:${sourceUuid}:${legacy.inputHash}`), false);
  });
}

test('resolution readback tolerates JSONB object-key ordering but refuses a changed original-record hash', async (t) => {
  const { snapshot, style, repo, client, importer } = await setup(t, 9, { existing: true });
  const legacy = legacyFailed(style), legacyKey = keys(style).legacy;
  repo.operations.set(legacyKey, structuredClone(legacy));
  await importer.importSnapshot(snapshot, { apply: true });
  const key = `variant-media-resolution:${sourceUuid}:${legacy.inputHash}`, original = structuredClone(repo.operations.get(key));
  repo.operations.set(key, stable(original));
  const count = repo.saves.filter((save) => save.kind === 'operation').length;
  await importer.importSnapshot(snapshot, { apply: true });
  assert.equal(repo.saves.filter((save) => save.kind === 'operation').length, count);
  assert.deepEqual(repo.operations.get(key), original);
  const changed = { ...repo.operations.get(key), originalRecordSha256: '0'.repeat(64) };
  repo.operations.set(key, changed);
  await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /resolution differs/);
  assert.deepEqual(repo.operations.get(key), changed); assert.deepEqual(repo.operations.get(legacyKey), legacy);
  assert.equal(mutations(client).length, 0);
});

for (const keyType of ['legacy', 'primary']) {
  test(`unrecognized ${keyType} journal status remains guarded before resolution or mapping`, async (t) => {
    const { snapshot, style, repo, client, importer } = await setup(t, 7, { existing: true });
    const key = keys(style)[keyType], original = { ...legacyFailed(style), status: 'future-state' };
    repo.operations.set(key, structuredClone(original));
    await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /Unrecognized variant-media journal state/);
    assert.equal(mutations(client).length, 0); assert.equal(repo.products.size, 0);
    assert.deepEqual(repo.operations.get(key), original);
    assert.equal(repo.saves.some((save) => save.kind === 'operation' || save.kind === 'product'), false);
  });
}

test('partial provider failure preserves the original input and blocks replay using a changed remaining subset', async (t) => {
  const { snapshot, style, repo, client, importer } = await setup(t, 9, { existing: true, missing: [0, 1], partialAttachFailure: true });
  await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /primary-image association rejected/);
  const key = keys(style).primary, failed = structuredClone(repo.operations.get(key));
  assert.equal(failed.status, 'failed'); assert.equal(failed.input.length, 2);
  assert.equal(client.product.variants.nodes[0].media.nodes.length, 1);
  assert.equal(client.product.variants.nodes[1].media.nodes.length, 0);
  await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), /Frozen Shopify operation input differs/);
  assert.deepEqual(repo.operations.get(key), failed); assert.equal(repo.products.size, 0);
  assert.equal(client.calls.filter((call) => call.operation === 'BridgeVariantMediaAttach').length, 1);
});

test('the synthetic provider rejects multi-ID pairs, duplicate pairs and an already associated variant', async () => {
  const data = fixture(7), { style } = data;
  const call = (client, pairs) => client.request('mutation BridgeVariantMediaAttach { synthetic }', { productId, variantMedia: pairs }, { kind: 'mutation' });
  const multi = clientFor(data, { existing: true, missing: [0, 1] });
  assert.equal((await call(multi, [{ variantId: variantGid(0), mediaIds: [mediaGid(style, style.images[0].sha256), mediaGid(style, style.images[1].sha256)] }]))
    .productVariantAppendMedia.userErrors[0].code, 'INVALID_MEDIA_INPUT');
  const duplicate = clientFor(data, { existing: true, missing: [0, 1] });
  const pair = { variantId: variantGid(0), mediaIds: [mediaGid(style, style.images[0].sha256)] };
  assert.equal((await call(duplicate, [pair, pair])).productVariantAppendMedia.userErrors[0].code, 'INVALID_MEDIA_INPUT');
  const existing = clientFor(data, { existing: true });
  assert.equal((await call(existing, [pair])).productVariantAppendMedia.userErrors[0].code, 'PRODUCT_VARIANT_ALREADY_HAS_MEDIA');
});
