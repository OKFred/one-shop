import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCatalogImporter } from '../src/services/catalog.js';
import { UnknownMutationOutcomeError } from '../src/services/shopifyClient.js';
import { buildAdoptionPlan, createCatalogAdopter, verifyPriceIdentity, assertGlobalSkuOwnership } from '../src/services/adoption.js';
import { enqueuePriceChanges, applyPriceIntent } from '../src/services/worker.js';
import { adoptExisting } from '../../../scripts/shopify/adopt-existing.mjs';

// Every identity, original and provider response below is synthetic.  In
// particular, a live ACTIVE target deliberately differs from native marketing
// copy and request capacity so that adoption cannot accidentally overwrite it.
const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const anchorUuid = '20000000-0000-4000-8000-000000000001';
const blueUuid = '20000000-0000-4000-8000-000000000002';
const imageHash = digest('synthetic-adoption-original');
const at = '2026-10-17T12:00:00.000Z';
const signCatalog = (value) => {
  const { contentSha256, ...unsigned } = value;
  return { ...unsigned, contentSha256: digest(unsigned) };
};

function nativeCatalog() {
  return signCatalog({ schemaVersion: 1, currency: 'USD', pricePolicy: 'source-resale-usd-times-1.5-ceiling-.99', capturedAt: at,
    styles: [{ sourceId: 'L2001', sourceUuid: anchorUuid, handle: 'l2001', category: 'dresses', title: 'Synthetic Native Dress',
      descriptionHtml: '<p>Native source description</p>', seo: { title: 'Native title', description: 'Native SEO description' },
      canonicalPath: '/dresses/l2001', publishedAt: '2026-10-16T02:00:00.000Z',
      images: [{ sha256: imageHash, localPath: `media/source-library/${imageHash}.png`, bytes: 31, width: 1, height: 1, alt: 'Synthetic original' }],
      variants: [{ uuid: anchorUuid, sku: 'SHUSHA-L2001', sourceVariantSku: 'RED-S', color: 'Red', size: 'S', sourceUsd: '10.00', retailUsd: '15.99', remainingCapacity: 17, imageHashes: [imageHash] },
        { uuid: blueUuid, sku: 'SHUSHA-L2001-V-BLUE-M', sourceVariantSku: 'BLUE-M', color: 'Blue', size: 'M', sourceUsd: '10.00', retailUsd: '15.99', remainingCapacity: -2, imageHashes: [imageHash] }] }] });
}

function providerProduct(style = nativeCatalog().styles[0], { marker = null, handle = 'merchant-kept-dress' } = {}) {
  return { id: 'gid://shopify/Product/2001', handle, status: 'ACTIVE', title: 'Reviewed merchant title',
    descriptionHtml: '<p>Reviewed merchant description</p>', vendor: 'SHUSHA', productType: 'Merchant dress category',
    seo: { title: 'Merchant SEO title', description: 'Merchant SEO description' }, metafield: marker ? { value: marker } : null,
    sourceUuid: marker,
    media: [{ id: 'gid://shopify/MediaImage/2001', mediaContentType: 'IMAGE', status: 'READY', alt: 'Merchant alternate text',
      url: `https://cdn.shopify.com/s/files/1/shusha-${imageHash}.png`, width: 1, height: 1 }],
    variants: style.variants.map((variant, index) => ({ id: `gid://shopify/ProductVariant/${2001 + index}`, sku: variant.sku, price: '11.99',
      inventoryPolicy: 'CONTINUE', selectedOptions: [{ name: 'Color', value: variant.color }, { name: 'Size', value: variant.size }],
      inventoryItem: { id: `gid://shopify/InventoryItem/${2001 + index}`, tracked: false, requiresShipping: true },
      mediaIds: ['gid://shopify/MediaImage/2001'], inventoryLevels: [{ id: `gid://shopify/InventoryLevel/${2001 + index}`,
        location: { id: 'gid://shopify/Location/2001', name: 'Synthetic merchant location' },
        quantities: [{ name: 'available', quantity: 4 - index }, { name: 'committed', quantity: index }, { name: 'on_hand', quantity: 4 }] }] })) };
}

function repository() {
  const products = new Map(), media = new Map(), operations = new Map(), saves = [];
  return { products, media, operations, saves,
    async withLock(key, action) { return action(); },
    async getProduct(key) { return structuredClone(products.get(key)); },
    async saveProduct(key, value) { products.set(key, structuredClone(value)); saves.push({ kind: 'product', key, value: structuredClone(value) }); },
    async getMedia(key) { return structuredClone(media.get(key)); },
    async saveMedia(key, value) { media.set(key, structuredClone(value)); saves.push({ kind: 'media', key, value: structuredClone(value) }); },
    async getOperation(key) { return structuredClone(operations.get(key)); },
    async saveOperation(key, value) { operations.set(key, structuredClone(value)); saves.push({ kind: 'operation', key, value: structuredClone(value) }); },
    async listUnresolvedOperations() { return [...operations].filter(([, record]) => ['sent', 'unknown'].includes(record.status)).map(([key, record]) => ({ key, record: structuredClone(record) })); } };
}

function auditProposal(snapshot, products) {
  const styles = snapshot.styles.map((style) => {
    const product = products.find((row) => row.variants.some((variant) => variant.sku === style.variants[0].sku));
    const variants = style.variants.map((expected) => {
      const actual = product.variants.find((row) => row.sku === expected.sku);
      return { sourceVariantUuid: expected.uuid, sourceVariantSku: expected.sourceVariantSku, sku: expected.sku,
        variantGid: actual.id, inventoryItemGid: actual.inventoryItem.id, expectedColor: expected.color, expectedSize: expected.size,
        actualSelectedOptions: actual.selectedOptions, optionsMatch: true, sourceUsd: expected.sourceUsd, targetRetailUsd: expected.retailUsd,
        currentShopifyUsd: actual.price, priceChangeRequired: actual.price !== expected.retailUsd,
        nativeRemainingRequestCapacity: expected.remainingCapacity, expectedImageHashes: expected.imageHashes,
        currentVariantMediaGids: actual.mediaIds, filenameInferredImageHashes: expected.imageHashes,
        inventoryPolicy: actual.inventoryPolicy, tracked: actual.inventoryItem.tracked, requiresShipping: actual.inventoryItem.requiresShipping,
        currentInventoryLevels: actual.inventoryLevels, inventoryLevelsSha256: digest(actual.inventoryLevels) };
    });
    return { sourceId: style.sourceId, sourceUuid: style.sourceUuid, nativeCanonicalPath: style.canonicalPath,
      expectedNativeHandle: style.handle, status: 'IDENTITY_MATCH_REQUIRES_MERCHANT_ADOPTION_REVIEW',
      blockingLabels: [], reviewLabels: ['SOURCE_UUID_OWNER_MARKER_ABSENT', 'PRESERVE_DIFFERENT_EXISTING_SHOPIFY_HANDLE',
        'PRESERVE_REVIEWED_MANUAL_PRODUCT_METADATA', 'REMOTE_ORIGINAL_BYTES_NOT_VERIFIED_BY_FILENAME', 'EXISTING_INVENTORY_METADATA_REVIEW_REQUIRED'],
      duplicateSkus: [], missingSkus: [], candidateProductGids: [product.id],
      existing: { productGid: product.id, handle: product.handle, status: product.status,
        currentRelativeUrl: `/products/${product.handle}`, sourceUuidMarker: product.sourceUuid,
        observedStructureSha256: digest({ id: product.id, handle: product.handle, status: product.status, title: product.title,
          descriptionHtml: product.descriptionHtml, vendor: product.vendor, productType: product.productType, seo: product.seo,
          variants: product.variants, media: product.media }), metadataDriftFields: ['title', 'descriptionHtml', 'productType', 'seoTitle', 'seoDescription'] },
      variants, media: product.media.map((item) => ({ mediaGid: item.id, mediaContentType: item.mediaContentType, status: item.status,
        observedFilename: `shusha-${imageHash}.png`, filenameSourceHash: imageHash, correspondsToNativeOriginal: true, remoteOriginalBytesVerified: false })),
      adoptionProposal: { action: 'REVIEW_EXISTING_PRICE_ONLY_ADOPTION_NO_APPLY', preserveStatus: product.status, preserveHandle: product.handle,
        preserveProductGid: product.id, preserveMediaGids: product.media.map((item) => item.id),
        preserveInventoryItemGids: product.variants.map((variant) => variant.inventoryItem.id),
        preserveInventoryLevelsSha256: digest(product.variants.map((variant) => ({ id: variant.id, levels: variant.inventoryLevels }))),
        proposedPriceChanges: variants.filter((variant) => variant.priceChangeRequired).map((variant) => ({ id: variant.variantGid, sku: variant.sku, from: variant.currentShopifyUsd, to: variant.targetRetailUsd })),
        onlyFutureReviewedMutation: 'productVariantsBulkUpdate: id+price', sourceUuidOwnershipChangePerformed: false,
        mappingWritesPerformed: false, merchantReviewRequired: true, publicCodeCompatibilityReviewRequired: true } };
  });
  return signProposal({ schemaVersion: 1, status: 'existing-catalog-adoption-proposal-no-apply', capturedAt: at,
    sourceContainerId: 'a'.repeat(64), sourceImage: `sha256:${'b'.repeat(64)}`, shop: 'synthetic-adoption.myshopify.com',
    grantedScopes: ['read_products', 'write_products', 'read_files', 'write_files', 'read_inventory', 'read_locations'],
    nativeCatalogContentSha256: snapshot.contentSha256, nativeSnapshotSha256: digest(snapshot), providerCatalogSha256: digest(products),
    pricePolicy: snapshot.pricePolicy, currency: 'USD', styles, globalSkuCollisions: [], unmatchedProviderProducts: [],
    metadataOnlyMediaCorrelation: true, remoteOriginalBytesVerified: false, visualAcceptanceClaimed: false,
    mappingWrites: 0, providerMutations: 0, tokenRefreshes: 0, automaticAdoption: false, jobsEnabled: false });
}

function signProposal(value) {
  const { proposalSha256, ...unsigned } = value;
  return { ...unsigned, proposalSha256: digest(unsigned) };
}

function fakeClient(products, { mappingStore, loseOwnerResponse = null, losePriceResponse = null } = {}) {
  const state = structuredClone(products), calls = [];
  const connection = (nodes) => ({ nodes: structuredClone(nodes), pageInfo: { hasNextPage: false, endCursor: null } });
  const selected = (id) => state.find((product) => product.id === id);
  const graphProduct = (product) => product && ({ ...structuredClone(product), variants: connection(product.variants), media: connection(product.media.map((media) => ({ ...media,
    image: { url: media.url, width: media.width, height: media.height, altText: media.alt } }))) });
  const client = { calls, state,
    async uploadStaged() { calls.push({ operation: 'UPLOAD' }); throw new Error('Adoption must never upload'); },
    async request(document, variables = {}, options = {}) {
      const operation = document.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      calls.push({ operation, variables: structuredClone(variables), options: structuredClone(options), document });
      if (['BridgeCurrency', 'BridgeAdoptionCurrency'].includes(operation)) return { shop: { currencyCode: 'USD' } };
      if (operation === 'BridgeGlobalOwners') return { products: connection(state.map(({ id, metafield }) => ({ id, metafield }))) };
      if (operation === 'BridgeGlobalSku') {
        const query = variables.query || '';
        const nodes = state.flatMap((product) => product.variants.map((variant) => ({ ...variant,
          product: { id: product.id, handle: product.handle, status: product.status, metafield: product.metafield } })))
          .filter((variant) => query.includes(variant.sku));
        return { productVariants: connection(nodes) };
      }
      if (operation === 'BridgeAdoptionProduct') return { product: graphProduct(selected(variables.id)), productByIdentifier: graphProduct(selected(variables.id)) };
      if (operation === 'BridgeAdoptionMedia') return { product: { id: variables.id, media: connection(selected(variables.id).media.map((media) => ({ ...media,
        image: { url: media.url, width: media.width, height: media.height, altText: media.alt } }))) } };
      if (operation === 'BridgeAdoptionVariantMedia') return { nodes: variables.ids.map((id) => {
        const variant = state.flatMap((product) => product.variants).find((row) => row.id === id);
        return { id, media: connection(variant.mediaIds.map((mediaId) => ({ id: mediaId }))) };
      }) };
      if (operation === 'BridgeAdoptionInventory') return { nodes: variables.ids.map((id) => {
        const variant = state.flatMap((product) => product.variants).find((row) => row.inventoryItem.id === id);
        return { ...variant.inventoryItem, sku: variant.sku, inventoryLevels: connection(variant.inventoryLevels) };
      }) };
      if (operation === 'BridgeAdoptOwner') {
        const inputs = variables.metafields || variables.input;
        assert.equal(inputs.length, 1);
        const input = inputs[0];
        assert.deepEqual(Object.keys(input).sort(), ['compareDigest', 'key', 'namespace', 'ownerId', 'type', 'value']);
        assert.equal(input.compareDigest, null); assert.equal(input.namespace, 'shusha_bridge'); assert.equal(input.key, 'source_uuid');
        assert.equal(input.type, 'single_line_text_field');
        assert.equal(options.kind, 'mutation'); assert.notEqual(options.safeRetry, true);
        assert.ok([...mappingStore.operations.values()].some((intent) => intent.status === 'sent'), 'durable intent must precede CAS');
        const loseThisOwner = !client.loseOwnerResponseFor || client.loseOwnerResponseFor === input.ownerId;
        if (loseThisOwner && loseOwnerResponse === 'before') throw new UnknownMutationOutcomeError();
        const product = selected(input.ownerId);
        assert.equal(product.sourceUuid, null, 'CAS must not replace an existing marker');
        product.sourceUuid = input.value; product.metafield = { value: input.value, compareDigest: digest(input.value) };
        if (loseThisOwner && loseOwnerResponse === 'after') throw new UnknownMutationOutcomeError();
        return { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/2001', ...input, compareDigest: digest(input.value) }], userErrors: [] } };
      }
      if (operation === 'BridgeProduct') {
        const product = state.find((row) => variables.identifier?.id === row.id || variables.identifier?.handle === row.handle);
        return { productByIdentifier: graphProduct(product) };
      }
      if (operation === 'BridgePrices') {
        assert.deepEqual(Object.keys(variables).sort(), ['productId', 'variants']);
        if (client.persistedPriceIntent) assert.deepEqual(variables, { productId: client.persistedPriceIntent.productId, variants: client.persistedPriceIntent.variants });
        else assert.ok([...mappingStore.operations.values()].some((intent) => intent.status === 'sent'), 'durable price intent must precede bulk mutation');
        if (losePriceResponse === 'before') throw new UnknownMutationOutcomeError();
        const product = selected(variables.productId);
        for (const variant of variables.variants) {
          assert.deepEqual(Object.keys(variant).sort(), ['id', 'price']);
          product.variants.find((row) => row.id === variant.id).price = variant.price;
        }
        if (losePriceResponse === 'after') throw new UnknownMutationOutcomeError();
        return { productVariantsBulkUpdate: { productVariants: structuredClone(variables.variants), userErrors: [] } };
      }
      throw new Error(`Unexpected synthetic adoption operation ${operation}`);
    } };
  return client;
}

function protectedProduct(product) {
  const copy = structuredClone(product);
  delete copy.metafield; delete copy.sourceUuid;
  for (const variant of copy.variants) delete variant.price;
  return copy;
}

function adoptionFixture(options = {}) {
  const snapshot = nativeCatalog(), product = providerProduct(snapshot.styles[0], options);
  const products = [product], proposal = auditProposal(snapshot, products), mappingStore = repository();
  const client = fakeClient(products, { mappingStore, loseOwnerResponse: options.loseOwnerResponse, losePriceResponse: options.losePriceResponse });
  return { snapshot, products, proposal, mappingStore, client,
    plan: buildAdoptionPlan(proposal, snapshot, products),
    adopter: createCatalogAdopter({ client, mappingStore, now: () => Date.parse(at) }) };
}

test('reviewed ACTIVE adoption freezes exact native association and preserves merchant resources', async () => {
  const fixture = adoptionFixture(), { adopter, plan, mappingStore, client, snapshot } = fixture;
  const before = protectedProduct(client.state[0]);
  assert.match(plan.preparedSha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.styles.length, 1);
  await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  const mapping = mappingStore.products.get(anchorUuid);
  assert.equal(mapping.mode, 'adopted-price-only-v1'); assert.equal(mapping.productGid, client.state[0].id);
  assert.equal(mapping.handle, 'merchant-kept-dress'); assert.equal(mapping.sourceUuid, anchorUuid);
  assert.match(mapping.sourceIdentitySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(mapping.variants.map(({ uuid, sku, color, size }) => ({ uuid, sku, color, size })),
    snapshot.styles[0].variants.map(({ uuid, sku, color, size }) => ({ uuid, sku, color, size })));
  assert.deepEqual(protectedProduct(client.state[0]), before);
  assert.equal(client.state[0].status, 'ACTIVE'); assert.equal(client.state[0].sourceUuid, anchorUuid);
  assert.deepEqual(client.calls.filter((call) => call.options.kind === 'mutation').map((call) => call.operation), ['BridgeAdoptOwner']);
  assert.equal(mappingStore.media.size, 0, 'adoption does not claim verified source original bytes');
  const calls = client.calls.length;
  await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  assert.equal(client.calls.slice(calls).some((call) => call.options.kind === 'mutation'), false);
});

test('an already matching source owner never receives another ownership write', async () => {
  const { adopter, plan, client, mappingStore } = adoptionFixture({ marker: anchorUuid });
  await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  assert.equal(client.calls.some((call) => call.options.kind === 'mutation'), false);
  assert.equal(mappingStore.products.get(anchorUuid).mode, 'adopted-price-only-v1');
});

test('prepare independently reads current native-USD catalog, exact proposal and global owners without writing', async () => {
  const { adopter, plan, proposal, snapshot, client, mappingStore } = adoptionFixture();
  assert.deepEqual(await adopter.prepare({ proposal, snapshot }), plan);
  assert.ok(client.calls.some((call) => call.operation === 'BridgeGlobalOwners'));
  assert.equal(client.calls.some((call) => call.options.kind === 'mutation'), false);
  assert.equal(mappingStore.operations.size, 0); assert.equal(mappingStore.products.size, 0);
});

test('proposal, exact source snapshot and explicitly reviewed plan hashes cannot be substituted', async () => {
  const snapshot = nativeCatalog(), product = providerProduct(snapshot.styles[0]), products = [product], proposal = auditProposal(snapshot, products);
  const corrupt = structuredClone(proposal); corrupt.styles[0].existing.handle = 'unreviewed-handle';
  assert.throws(() => buildAdoptionPlan(corrupt, snapshot, products));
  const changedSource = structuredClone(snapshot); changedSource.styles[0].variants[0].uuid = '20000000-0000-4000-8000-000000000003';
  assert.throws(() => buildAdoptionPlan(proposal, signCatalog(changedSource), products));
  const resigned = structuredClone(proposal); resigned.styles[0].variants[0].sourceVariantUuid = blueUuid;
  assert.throws(() => buildAdoptionPlan(signProposal(resigned), snapshot, products));
  const { adopter, plan, client, mappingStore } = adoptionFixture();
  await assert.rejects(adopter.apply(plan, { reviewedSha256: '0'.repeat(64) }));
  assert.equal(client.calls.length, 0); assert.equal(mappingStore.operations.size, 0); assert.equal(mappingStore.products.size, 0);
});

test('foreign source marker is refused rather than overwritten by compare-and-set', () => {
  const snapshot = nativeCatalog(), products = [providerProduct(snapshot.styles[0], { marker: blueUuid })];
  const proposal = auditProposal(snapshot, products);
  assert.throws(() => buildAdoptionPlan(proposal, snapshot, products));
});

test('unknown CAS after actual success reconciles only original frozen intent without another mutation', async () => {
  const { adopter, plan, client, mappingStore } = adoptionFixture({ loseOwnerResponse: 'after' });
  await assert.rejects(adopter.apply(plan, { reviewedSha256: plan.preparedSha256 }), UnknownMutationOutcomeError);
  assert.equal(mappingStore.products.size, 0);
  const [originalKey, originalIntent] = [...mappingStore.operations].find(([, value]) => value.status === 'unknown');
  assert.ok(originalKey); assert.equal(client.state[0].sourceUuid, anchorUuid);
  const mutations = client.calls.filter((call) => call.options.kind === 'mutation').length;
  await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  assert.equal(client.calls.filter((call) => call.options.kind === 'mutation').length, mutations);
  assert.equal(mappingStore.products.get(anchorUuid).mode, 'adopted-price-only-v1');
  const recovered = mappingStore.operations.get(originalKey);
  assert.equal(recovered.status, 'complete'); assert.deepEqual(recovered.input, originalIntent.input);
});

test('unknown CAS with absent marker remains unresolved and never blindly retries the original mutation', async () => {
  const { adopter, plan, client, mappingStore } = adoptionFixture({ loseOwnerResponse: 'before' });
  await assert.rejects(adopter.apply(plan, { reviewedSha256: plan.preparedSha256 }), UnknownMutationOutcomeError);
  const mutations = client.calls.filter((call) => call.options.kind === 'mutation').length;
  await assert.rejects(adopter.apply(plan, { reviewedSha256: plan.preparedSha256 }));
  assert.equal(client.calls.filter((call) => call.options.kind === 'mutation').length, mutations);
  assert.equal(mappingStore.products.size, 0);
  assert.ok([...mappingStore.operations.values()].some((intent) => ['sent', 'unknown'].includes(intent.status)));
});

test('a newly rebased plan cannot clear another original unknown CAS journal', async () => {
  const { adopter, plan, client, mappingStore, snapshot } = adoptionFixture({ loseOwnerResponse: 'after' });
  await assert.rejects(adopter.apply(plan, { reviewedSha256: plan.preparedSha256 }), UnknownMutationOutcomeError);
  const freshProposal = auditProposal(snapshot, client.state);
  const freshPlan = buildAdoptionPlan(freshProposal, snapshot, client.state);
  assert.notEqual(freshPlan.preparedSha256, plan.preparedSha256);
  const callCount = client.calls.length;
  await assert.rejects(adopter.apply(freshPlan, { reviewedSha256: freshPlan.preparedSha256 }));
  assert.equal(client.calls.slice(callCount).some((call) => call.options.kind === 'mutation'), false);
  assert.equal(mappingStore.products.size, 0);
  assert.ok([...mappingStore.operations.values()].some((intent) => intent.status === 'unknown'));
});

test('a crash after CAS but before mapping completion reconciles the original sent intent without resending', async () => {
  const { adopter, plan, client, mappingStore } = adoptionFixture();
  const saveProduct = mappingStore.saveProduct;
  let fail = true;
  mappingStore.saveProduct = async (...args) => {
    if (fail) { fail = false; throw new Error('Synthetic interruption before mapping commit'); }
    return saveProduct(...args);
  };
  await assert.rejects(adopter.apply(plan, { reviewedSha256: plan.preparedSha256 }), /Synthetic interruption/);
  assert.equal(mappingStore.products.size, 0);
  assert.ok([...mappingStore.operations.values()].some((intent) => intent.status === 'sent'));
  const mutationCount = client.calls.filter((call) => call.options.kind === 'mutation').length;
  await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  assert.equal(client.calls.filter((call) => call.options.kind === 'mutation').length, mutationCount);
  assert.equal(mappingStore.products.get(anchorUuid).mode, 'adopted-price-only-v1');
  assert.equal([...mappingStore.operations.values()].some((intent) => ['sent', 'unknown'].includes(intent.status)), false);
});

test('original two-style plan recovers unknown second CAS beyond its already-completed first style without resending either', async () => {
  const value = nativeCatalog(), second = structuredClone(value.styles[0]);
  second.sourceId = 'L2002'; second.handle = 'l2002'; second.canonicalPath = '/dresses/l2002';
  second.sourceUuid = '20000000-0000-4000-8000-000000000003';
  second.variants[0].uuid = second.sourceUuid; second.variants[0].sku = 'SHUSHA-L2002';
  second.variants[1].uuid = '20000000-0000-4000-8000-000000000004'; second.variants[1].sku = 'SHUSHA-L2002-V-BLUE-M';
  value.styles.push(second); const snapshot = signCatalog(value);
  const product = providerProduct(value.styles[0]), other = providerProduct(second, { handle: 'merchant-kept-dress-two' });
  other.id = 'gid://shopify/Product/2002';
  for (const [index, variant] of other.variants.entries()) {
    variant.id = `gid://shopify/ProductVariant/${3001 + index}`;
    variant.inventoryItem.id = `gid://shopify/InventoryItem/${3001 + index}`;
  }
  const products = [product, other], mappingStore = repository();
  const client = fakeClient(products, { mappingStore, loseOwnerResponse: 'after' });
  client.loseOwnerResponseFor = other.id;
  const proposal = auditProposal(snapshot, products), plan = buildAdoptionPlan(proposal, snapshot, products);
  const adopter = createCatalogAdopter({ client, mappingStore, now: () => Date.parse(at) });
  await assert.rejects(adopter.apply(plan, { reviewedSha256: plan.preparedSha256 }), UnknownMutationOutcomeError);
  assert.equal(mappingStore.products.size, 1); assert.ok(mappingStore.products.has(anchorUuid));
  assert.ok([...mappingStore.operations.values()].some((intent) => intent.status === 'unknown'));
  const mutationCount = client.calls.filter((call) => call.options.kind === 'mutation').length;
  assert.equal(mutationCount, 2);
  const result = await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  assert.equal(result.existing, 1); assert.equal(result.adopted, 1); assert.equal(mappingStore.products.size, 2);
  assert.equal(client.calls.filter((call) => call.options.kind === 'mutation').length, mutationCount);
  assert.equal([...mappingStore.operations.values()].some((intent) => ['sent', 'unknown'].includes(intent.status)), false);
});

function competingOwner(product) {
  const other = structuredClone(product);
  other.id = 'gid://shopify/Product/2999'; other.handle = 'foreign-source-owner'; other.sourceUuid = anchorUuid;
  other.metafield = { value: anchorUuid }; other.variants = [other.variants[0]];
  other.variants[0].id = 'gid://shopify/ProductVariant/2999'; other.variants[0].sku = 'UNRELATED-EXISTING-SKU';
  return other;
}

test('prepare refuses a source UUID already owned under another handle even with disjoint SKUs', async () => {
  const { adopter, proposal, snapshot, client, mappingStore } = adoptionFixture();
  client.state.push(competingOwner(client.state[0]));
  await assert.rejects(adopter.prepare({ proposal, snapshot }));
  assert.equal(client.calls.some((call) => call.options.kind === 'mutation'), false);
  assert.equal(mappingStore.products.size, 0);
});

test('a new competing source UUID owner after review blocks adoption before CAS', async () => {
  const { adopter, plan, client, mappingStore } = adoptionFixture();
  client.state.push(competingOwner(client.state[0]));
  await assert.rejects(adopter.apply(plan, { reviewedSha256: plan.preparedSha256 }));
  assert.equal(client.calls.some((call) => call.options.kind === 'mutation'), false);
  assert.equal(mappingStore.products.size, 0);
});

test('a SKU on a different Shopify handle blocks globally before any staged upload or creation', async () => {
  const snapshot = nativeCatalog(), product = providerProduct(snapshot.styles[0]), other = structuredClone(product);
  other.id = 'gid://shopify/Product/2999'; other.handle = 'another-existing-product';
  other.variants = [other.variants[0]]; other.variants[0].id = 'gid://shopify/ProductVariant/2999';
  const mappingStore = repository(), client = fakeClient([product, other], { mappingStore });
  await assert.rejects(assertGlobalSkuOwnership({ client, style: snapshot.styles[0], productId: product.id }));
  assert.equal(client.calls.some((call) => call.options.kind === 'mutation' || call.operation === 'UPLOAD'), false);
  const importer = createCatalogImporter({ client, mappingStore, mediaRoot: 'never-read-for-sku-conflict' });
  await assert.rejects(importer.importSnapshot(snapshot, { apply: true }));
  assert.equal(client.calls.some((call) => call.options.kind === 'mutation' || call.operation === 'UPLOAD'), false);
  assert.equal(mappingStore.products.size, 0); assert.equal(mappingStore.media.size, 0);
});

test('adopted ACTIVE price synchronization writes only id and new 1.5 retail prices', async () => {
  const { adopter, plan, client, mappingStore, snapshot } = adoptionFixture();
  await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  const before = protectedProduct(client.state[0]), callCount = client.calls.length;
  const importer = createCatalogImporter({ client, mappingStore, mediaRoot: 'never-read-for-adopted-price-only' });
  const result = await importer.importSnapshot(snapshot, { apply: true });
  assert.equal(result.changedPrices, 2); assert.equal(result.draftsCreated, 0);
  assert.deepEqual(client.state[0].variants.map((row) => row.price), ['15.99', '15.99']);
  assert.deepEqual(protectedProduct(client.state[0]), before);
  assert.deepEqual(client.calls.slice(callCount).filter((call) => call.options.kind === 'mutation').map((call) => call.operation), ['BridgePrices']);
  const repeatCalls = client.calls.length;
  assert.equal((await importer.importSnapshot(snapshot, { apply: true })).changedPrices, 0);
  assert.equal(client.calls.slice(repeatCalls).some((call) => call.options.kind === 'mutation'), false);
});

test('a competing source UUID owner blocks subsequent adopted price mutation even with disjoint SKUs', async () => {
  const { adopter, plan, client, mappingStore, snapshot } = adoptionFixture();
  await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  client.state.push(competingOwner(client.state[0]));
  const callCount = client.calls.length;
  const importer = createCatalogImporter({ client, mappingStore, mediaRoot: 'never-read-for-adopted-price-only' });
  await assert.rejects(importer.importSnapshot(snapshot, { apply: true }));
  assert.equal(client.calls.slice(callCount).some((call) => call.options.kind === 'mutation'), false);
});

for (const when of ['before', 'after']) {
  test(`an unknown adopted price result ${when} application preserves original input and prevents blind retry`, async () => {
    const { adopter, plan, client, mappingStore, snapshot } = adoptionFixture({ losePriceResponse: when });
    await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
    const importer = createCatalogImporter({ client, mappingStore, mediaRoot: 'never-read-for-adopted-price-only' });
    await assert.rejects(importer.importSnapshot(snapshot, { apply: true }), UnknownMutationOutcomeError);
    const [key, intent] = [...mappingStore.operations].find(([operationKey]) => operationKey.startsWith('adopt-price:'));
    assert.ok(key); assert.equal(intent.status, 'unknown'); assert.equal(intent.input.productId, client.state[0].id);
    assert.deepEqual(intent.input.variants, client.state[0].variants.map((variant) => ({ id: variant.id, price: '15.99' })));
    assert.deepEqual(client.state[0].variants.map((row) => row.price), when === 'after' ? ['15.99', '15.99'] : ['11.99', '11.99']);
    const mutations = client.calls.filter((call) => call.options.kind === 'mutation').length;
    await assert.rejects(importer.importSnapshot(snapshot, { apply: true }));
    assert.equal(client.calls.filter((call) => call.options.kind === 'mutation').length, mutations);
    assert.deepEqual(mappingStore.operations.get(key), intent);
  });
}

test('legitimate Shopify order-consumed quantities remain outside the adopted price identity', async () => {
  const { adopter, plan, client, mappingStore, snapshot } = adoptionFixture();
  await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
  client.state[0].variants[0].inventoryLevels[0].quantities.find((row) => row.name === 'available').quantity = 0;
  client.state[0].variants[0].inventoryLevels[0].quantities.find((row) => row.name === 'committed').quantity = 4;
  const levels = structuredClone(client.state[0].variants.map((row) => row.inventoryLevels));
  const importer = createCatalogImporter({ client, mappingStore, mediaRoot: 'never-read-for-adopted-price-only' });
  assert.equal((await importer.importSnapshot(snapshot, { apply: true })).changedPrices, 2);
  assert.deepEqual(client.state[0].variants.map((row) => row.inventoryLevels), levels);
});

const priceDrifts = {
  'source owner': (product) => { product.sourceUuid = blueUuid; product.metafield.value = blueUuid; },
  'preserved handle': (product) => { product.handle = 'changed-live-handle'; },
  'missing variant SKU': (product) => { product.variants.pop(); },
  'extra variant SKU': (product) => { const copy = structuredClone(product.variants[0]); copy.id = 'gid://shopify/ProductVariant/2888'; copy.sku = 'UNMANAGED-EXTRA'; product.variants.push(copy); },
  'real size option': (product) => { product.variants[0].selectedOptions[1].value = 'XL'; },
  'variant owner GID': (product) => { product.variants[0].id = 'gid://shopify/ProductVariant/2888'; },
  'inventory owner GID': (product) => { product.variants[0].inventoryItem.id = 'gid://shopify/InventoryItem/2888'; },
  'merchant title': (product) => { product.title = 'New unreviewed merchant title'; },
  'merchant gallery metadata': (product) => { product.media[0].alt = 'Unreviewed new gallery text'; },
  'variant image association': (product) => { product.variants[0].mediaIds = []; },
  'inventory tracking metadata': (product) => { product.variants[0].inventoryItem.tracked = true; }
};
for (const [name, mutate] of Object.entries(priceDrifts)) {
  test(`live ${name} drift blocks adopted price mutation`, async () => {
    const { adopter, plan, client, mappingStore, snapshot } = adoptionFixture();
    await adopter.apply(plan, { reviewedSha256: plan.preparedSha256 });
    mutate(client.state[0]); const callCount = client.calls.length;
    await assert.rejects(verifyPriceIdentity({ client, mapping: mappingStore.products.get(anchorUuid), style: snapshot.styles[0] }));
    const importer = createCatalogImporter({ client, mappingStore, mediaRoot: 'never-read-for-adopted-price-only' });
    await assert.rejects(importer.importSnapshot(snapshot, { apply: true }));
    assert.equal(client.calls.slice(callCount).some((call) => call.options.kind === 'mutation'), false);
  });
}

function nativePriceRows(snapshot) {
  return snapshot.styles[0].variants.map((variant) => ({ uuid: variant.uuid, sku: variant.sku, price: variant.sourceUsd,
    options: [{ name: 'shusha_color', value: variant.color }, { name: 'shusha_size', value: variant.size }] }));
}

function syntheticPricePool(mapping, nativeRows) {
  const queries = [], outbox = [];
  const connection = { INTRANSACTION: false,
    async query(sql, params) {
      queries.push({ sql, params: structuredClone(params) });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT payload FROM shusha_bridge_outbox')) return { rows: outbox.length ? [{ payload: structuredClone(outbox.at(-1).payload) }] : [] };
      if (sql.includes('INSERT INTO shusha_bridge_outbox')) {
        assert.equal(connection.INTRANSACTION, true);
        outbox.push({ id: params[0], intentKey: params[1], kind: params[2], aggregateKey: params[3], payload: JSON.parse(params[4]) });
        return { rows: [{ id: params[0] }] };
      }
      throw new Error(`Unexpected synthetic price transaction SQL: ${sql}`);
    },
    release() { queries.push({ release: true }); } };
  return { queries, outbox, nativeRows,
    async query(sql, params) {
      queries.push({ sql, params: structuredClone(params) });
      if (sql.includes("SELECT source_key,record FROM shusha_bridge_mapping WHERE kind='product'")) return { rows: [{ source_key: mapping.sourceUuid, record: structuredClone(mapping) }] };
      assert.match(sql, /SELECT p\.uuid::text,p\.sku,p\.price/);
      assert.deepEqual(params, [mapping.variants.map((variant) => variant.sku)]);
      return { rows: structuredClone(nativeRows) };
    },
    async connect() { return connection; } };
}

async function workerFixture(options = {}) {
  const fixture = adoptionFixture(options);
  await fixture.adopter.apply(fixture.plan, { reviewedSha256: fixture.plan.preparedSha256 });
  const mapping = fixture.mappingStore.products.get(anchorUuid);
  const pool = syntheticPricePool(mapping, nativePriceRows(fixture.snapshot));
  const payload = { productId: mapping.productGid, sourceKey: anchorUuid, mappingSha256: digest(mapping),
    sourcePrices: fixture.snapshot.styles[0].variants.map((variant) => ({ sku: variant.sku, sourceUsd: variant.sourceUsd })),
    variants: mapping.variants.map((variant) => ({ id: variant.variantGid, price: '15.99' })) };
  const row = { id: '20000000-0000-4000-8000-000000000099', state: 'processing', kind: 'catalog.prices', payload };
  fixture.client.persistedPriceIntent = structuredClone(payload);
  return { ...fixture, mapping, pool, row };
}

test('worker price handler independently verifies current native identity and writes only the frozen id/price payload', async () => {
  const { client, pool, row, mappingStore } = await workerFixture();
  const frozen = structuredClone(row), before = protectedProduct(client.state[0]), callCount = client.calls.length;
  await applyPriceIntent(row, { client, pool, mappingStore });
  assert.deepEqual(row, frozen); assert.deepEqual(protectedProduct(client.state[0]), before);
  assert.deepEqual(client.state[0].variants.map((variant) => variant.price), ['15.99', '15.99']);
  const mutations = client.calls.slice(callCount).filter((call) => call.options.kind === 'mutation');
  assert.deepEqual(mutations.map((call) => call.operation), ['BridgePrices']);
  assert.deepEqual(mutations[0].variables, { productId: row.payload.productId, variants: row.payload.variants });
  assert.ok(pool.queries.some((query) => query.sql.includes('product_attribute_value_index')));
  const repeatCount = client.calls.length;
  await applyPriceIntent(row, { client, pool, mappingStore });
  assert.equal(client.calls.slice(repeatCount).some((call) => call.options.kind === 'mutation'), false);
});

const workerDrifts = {
  'native UUID': ({ pool }) => { pool.nativeRows[0].uuid = blueUuid; },
  'native real colour': ({ pool }) => { pool.nativeRows[0].options[0].value = 'Pink'; },
  'native real size': ({ pool }) => { pool.nativeRows[0].options[1].value = 'XL'; },
  'native missing SKU': ({ pool }) => { pool.nativeRows.pop(); },
  'stale mapping hash': ({ mappingStore }) => { mappingStore.products.get(anchorUuid).adoptedAt = '2026-10-17T12:01:00.000Z'; },
  'foreign live owner': ({ client }) => { client.state[0].sourceUuid = blueUuid; client.state[0].metafield.value = blueUuid; },
  'live variant GID': ({ client }) => { client.state[0].variants[0].id = 'gid://shopify/ProductVariant/2888'; },
  'legacy 1.1 markup': ({ row }) => { row.payload.variants[0].price = '11.99'; },
  'non-price field': ({ row }) => { row.payload.variants[0].inventoryPolicy = 'DENY'; },
  'incomplete source prices': ({ row }) => { row.payload.sourcePrices.pop(); },
  'duplicate source SKU': ({ row }) => { row.payload.sourcePrices[1].sku = row.payload.sourcePrices[0].sku; }
};
for (const [name, mutate] of Object.entries(workerDrifts)) {
  test(`worker refuses ${name} before sending any price mutation`, async () => {
    const fixture = await workerFixture(); mutate(fixture);
    const frozen = structuredClone(fixture.row), callCount = fixture.client.calls.length;
    await assert.rejects(applyPriceIntent(fixture.row, fixture));
    assert.deepEqual(fixture.row, frozen);
    assert.equal(fixture.client.calls.slice(callCount).some((call) => call.options.kind === 'mutation'), false);
  });
}

for (const when of ['before', 'after']) {
  test(`worker propagates unknown provider result ${when} application with original persisted payload intact`, async () => {
    const { client, pool, row, mappingStore } = await workerFixture({ losePriceResponse: when });
    const frozen = structuredClone(row), callCount = client.calls.length;
    await assert.rejects(applyPriceIntent(row, { client, pool, mappingStore }), UnknownMutationOutcomeError);
    assert.deepEqual(row, frozen);
    assert.equal(client.calls.slice(callCount).filter((call) => call.operation === 'BridgePrices').length, 1);
    assert.deepEqual(client.state[0].variants.map((variant) => variant.price), when === 'after' ? ['15.99', '15.99'] : ['11.99', '11.99']);
  });
}

test('native enqueue freezes source USD, current mapping and exact 1.5 prices once without touching stock', async () => {
  const { pool, mapping, snapshot } = await workerFixture();
  assert.deepEqual(await enqueuePriceChanges(pool), { queued: 1 });
  assert.equal(pool.outbox.length, 1);
  const intent = pool.outbox[0];
  assert.equal(intent.kind, 'catalog.prices'); assert.equal(intent.aggregateKey, `product:${mapping.productGid}`);
  assert.equal(intent.payload.mappingSha256, digest(mapping)); assert.equal(intent.payload.sourceKey, anchorUuid);
  assert.deepEqual(intent.payload.sourcePrices, snapshot.styles[0].variants.map((variant) => ({ sku: variant.sku, sourceUsd: variant.sourceUsd })));
  assert.deepEqual(intent.payload.variants, mapping.variants.map((variant) => ({ id: variant.variantGid, price: '15.99' })));
  const original = structuredClone(intent);
  assert.deepEqual(await enqueuePriceChanges(pool), { queued: 0 });
  assert.equal(pool.outbox.length, 1); assert.deepEqual(pool.outbox[0], original);
  assert.equal(pool.queries.some((query) => query.sql && /(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:product|product_inventory|shusha_bridge_inventory)\b/.test(query.sql)), false);
});

test('native enqueue refuses an altered real option before beginning any outbox transaction', async () => {
  const { pool } = await workerFixture();
  pool.nativeRows[0].options[1].value = 'XL';
  await assert.rejects(enqueuePriceChanges(pool));
  assert.equal(pool.outbox.length, 0);
  assert.equal(pool.queries.some((query) => query.sql === 'BEGIN'), false);
});

async function cliFixture(t) {
  const fixture = adoptionFixture();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-adoption-cli-')));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('shusha-adoption-cli-') && path.dirname(root) === await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const audit = path.join(root, 'shopify/audit-synthetic'); await fs.mkdir(audit, { recursive: true, mode: 0o700 });
  const write = (filename, data) => fs.writeFile(filename, JSON.stringify(data), { mode: 0o600 });
  const proposalPath = path.join(audit, 'proposal.private.json');
  await write(proposalPath, fixture.proposal);
  await write(path.join(audit, 'native-catalog.private.json'), fixture.snapshot);
  await write(path.join(audit, 'success.private.json'), { status: 'existing-catalog-readonly-audited-no-adoption',
    proposalSha256: fixture.proposal.proposalSha256, nativeAndMappingsUnchanged: true,
    providerCatalogAndInventoryStableAcrossReadbacks: true, providerWrites: 0, mappingWrites: 0 });
  fixture.client.shop = fixture.proposal.shop;
  const runtime = { config: { enabled: true, writesEnabled: true, shop: fixture.proposal.shop, scopes: fixture.proposal.grantedScopes },
    pool: {}, client: fixture.client, repositories: { mappings: fixture.mappingStore } };
  const env = { PRIVATE_DATA_DIR: root, SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_BRIDGE_WRITES_ENABLED: 'true' };
  const exports = [];
  const source = { snapshot: fixture.snapshot };
  const exporter = async ({ output }) => { exports.push(output); await write(output, source.snapshot); };
  return { ...fixture, root, runtime, env, proposalPath, exporter, exports, source };
}

test('CLI prepares original private audit and applies only its reviewed plan after fresh native identity readback', async (t) => {
  const fixture = await cliFixture(t), { env, runtime, proposalPath, exporter, client, mappingStore, source } = fixture;
  const prepared = await adoptExisting({ env, runtime, proposalPath, exporter });
  assert.equal(prepared.status, 'existing-adoption-plan-prepared');
  assert.equal(prepared.providerWrites, 0); assert.equal(prepared.mappingWrites, 0);
  assert.ok(prepared.planPath.startsWith(`${path.join(fixture.root, 'shopify/adoption')}${path.sep}`));
  assert.equal(mappingStore.products.size, 0);
  assert.equal(client.calls.some((call) => call.options.kind === 'mutation'), false);
  let callCount = client.calls.length;
  await assert.rejects(adoptExisting({ env, runtime, planPath: prepared.planPath, reviewedSha256: '0'.repeat(64), apply: true, exporter }));
  assert.equal(client.calls.length, callCount); assert.equal(mappingStore.products.size, 0);
  const changed = structuredClone(fixture.snapshot); changed.styles[0].variants[0].size = 'XL'; source.snapshot = signCatalog(changed);
  await assert.rejects(adoptExisting({ env, runtime, planPath: prepared.planPath, reviewedSha256: prepared.preparedSha256, apply: true, exporter }), /Current reviewed native UUID/);
  assert.equal(client.calls.length, callCount); assert.equal(mappingStore.products.size, 0);
  source.snapshot = fixture.snapshot;
  const applied = await adoptExisting({ env, runtime, planPath: prepared.planPath, reviewedSha256: prepared.preparedSha256, apply: true, exporter });
  assert.equal(applied.status, 'existing-products-adopted-price-only'); assert.equal(applied.adopted, 1);
  assert.equal(applied.existingPriceOnlyAdoption, true); assert.equal(applied.newDraftProviderAcceptanceClaimed, false);
  assert.equal(applied.jobsEnabled, false); assert.equal(applied.priceWrites, 0); assert.equal(applied.inventoryWrites, 0); assert.equal(applied.publicationWrites, 0);
  assert.deepEqual(client.calls.slice(callCount).filter((call) => call.options.kind === 'mutation').map((call) => call.operation), ['BridgeAdoptOwner']);
  assert.equal(mappingStore.products.get(anchorUuid).handle, 'merchant-kept-dress');
});

test('CLI refuses enabled jobs and unapproved scopes before exporter, private-path reads or provider requests', async () => {
  const fixture = adoptionFixture();
  const runtime = { config: { enabled: true, writesEnabled: true, shop: fixture.proposal.shop, scopes: fixture.proposal.grantedScopes },
    client: fixture.client, pool: {}, repositories: { mappings: fixture.mappingStore } };
  const env = { SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_BRIDGE_WRITES_ENABLED: 'true', PRIVATE_DATA_DIR: 'synthetic-nonexistent-private-root' };
  let exported = false;
  const exporter = async () => { exported = true; throw new Error('Exporter must not run through closed gate'); };
  await assert.rejects(adoptExisting({ env: { ...env, SHOPIFY_BRIDGE_JOBS_ENABLED: 'true' }, runtime,
    proposalPath: 'synthetic-nonexistent-audit.private.json', exporter }), /with jobs and other capabilities closed/);
  runtime.config.scopes = [...runtime.config.scopes, 'write_inventory'];
  await assert.rejects(adoptExisting({ env, runtime, proposalPath: 'synthetic-nonexistent-audit.private.json', exporter }), /six approved/);
  assert.equal(exported, false); assert.equal(fixture.client.calls.length, 0); assert.equal(fixture.mappingStore.products.size, 0);
});
