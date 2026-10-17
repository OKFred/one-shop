import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { UnknownMutationOutcomeError } from './shopifyClient.js';

export const ADOPTED_PRICE_ONLY = 'adopted-price-only-v1';
export const adoptionHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const gid = (value, type) => new RegExp(`^gid://shopify/${type}/[0-9]+$`).test(value || '');
const unresolved = record => ['sent', 'unknown'].includes(record?.status);
const SKU_READ = `query BridgeGlobalSku($query:String!,$after:String){productVariants(first:100,query:$query,after:$after){
  nodes{id sku product{id handle}} pageInfo{hasNextPage endCursor}}}`;
const OWNER_READ = `query BridgeGlobalOwners($after:String){products(first:100,after:$after){
  nodes{id metafield(namespace:"shusha_bridge",key:"source_uuid"){value}} pageInfo{hasNextPage endCursor}}}`;
const PRODUCT_READ = `query BridgeAdoptionProduct($id:ID!){product(id:$id){id handle status title descriptionHtml vendor productType seo{title description}
  metafield(namespace:"shusha_bridge",key:"source_uuid"){id value compareDigest}
  variants(first:100){nodes{id sku price inventoryPolicy selectedOptions{name value} inventoryItem{id tracked requiresShipping}} pageInfo{hasNextPage}}
  media(first:250){nodes{id mediaContentType status alt ... on MediaImage{image{url width height altText}}}pageInfo{hasNextPage}}}}`;
const ASSOCIATIONS_READ = `query BridgeAdoptionVariantMedia($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id media(first:100){nodes{id}pageInfo{hasNextPage}}}}}`;
const INVENTORY_READ = `query BridgeAdoptionInventory($ids:[ID!]!){nodes(ids:$ids){... on InventoryItem{id sku inventoryLevels(first:50){nodes{
  id location{id name}quantities(names:["available","on_hand","committed"]){name quantity}}pageInfo{hasNextPage}}}}}`;
const OWNER_WRITE = `mutation BridgeAdoptOwner($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){
  metafields{id namespace key value compareDigest}userErrors{code field}}}`;

async function pages(client, document, variables, select, limit = 2000) {
  const rows = [], seen = new Set(); let after = null;
  while (true) {
    const result = select(await client.request(document, { ...variables, after }));
    assert(result && Array.isArray(result.nodes) && result.pageInfo && rows.length + result.nodes.length <= limit, 'Complete bounded Shopify identity pagination is required');
    rows.push(...result.nodes);
    if (!result.pageInfo.hasNextPage) return rows;
    const cursor = result.pageInfo.endCursor;
    assert(typeof cursor === 'string' && cursor && !seen.has(cursor), 'Shopify identity pagination did not advance');
    seen.add(cursor); after = cursor;
  }
}

/** Exact search across every product, including manually imported other handles. */
export async function assertGlobalSkuOwnership({ client, style, productId = null }) {
  assert(Array.isArray(style?.variants) && style.variants.length > 0 && style.variants.length <= 100, 'Source variants are required for global SKU verification');
  const skus = style.variants.map(variant => variant.sku);
  assert(new Set(skus).size === skus.length && skus.every(sku => typeof sku === 'string' && /^SHUSHA-L\d{3,8}(?:-V-[A-Za-z0-9._-]{1,80})?$/.test(sku)), 'Managed source SKUs are invalid');
  const query = skus.map(sku => `sku:${JSON.stringify(sku)}`).join(' OR ');
  const found = await pages(client, SKU_READ, { query }, data => data.productVariants);
  assert(found.every(row => skus.includes(row.sku)), 'Shopify SKU search returned an inexact match; review required');
  if (!productId) assert(found.length === 0, 'Global Shopify SKU collision: adopt the existing product before any upload or creation');
  else for (const sku of skus) {
    const rows = found.filter(row => row.sku === sku);
    assert(rows.length === 1 && rows[0].product?.id === productId, 'Global Shopify SKU ownership is missing or ambiguous');
  }
  return found;
}

export async function assertNoUnresolvedOperations(mappingStore, exceptKey = null) {
  assert(typeof mappingStore.listUnresolvedOperations === 'function', 'Durable unresolved-operation inspection is required');
  const rows = await mappingStore.listUnresolvedOperations();
  const allowed = new Set(Array.isArray(exceptKey) ? exceptKey : exceptKey ? [exceptKey] : []);
  assert(rows.every(row => allowed.has(row.key)), 'An existing sent/unknown Shopify operation needs original-result review');
}

export async function assertGlobalSourceOwnership({ client, sourceUuid, productId, allowMissing = false }) {
  const products = await pages(client, OWNER_READ, {}, data => data.products);
  const owners = products.filter(product => product.metafield?.value === sourceUuid);
  assert(owners.length <= 1 && owners.every(product => product.id === productId) && (allowMissing || owners.length === 1),
    'Global Shopify source UUID ownership is missing or ambiguous');
}

export function sourceIdentitySha256(style) {
  return adoptionHash({ sourceUuid: style.sourceUuid, handle: style.handle, category: style.category,
    variants: style.variants.map(({ uuid, sku, color, size }) => ({ uuid, sku, color, size })).sort((a, b) => a.sku.localeCompare(b.sku)) });
}

export function auditStructureSha256(product) {
  return adoptionHash({ id: product.id, handle: product.handle, status: product.status, title: product.title,
    descriptionHtml: product.descriptionHtml, vendor: product.vendor, productType: product.productType,
    seo: product.seo, variants: product.variants, media: product.media });
}

/** Prices and legitimate order-consumed quantities are deliberately excluded. */
export function priceIdentityProjection(product) {
  return { id: product.id, handle: product.handle, status: product.status, title: product.title,
    descriptionHtml: product.descriptionHtml, vendor: product.vendor, productType: product.productType, seo: product.seo,
    media: product.media, variants: product.variants.map(variant => ({ id: variant.id, sku: variant.sku,
      selectedOptions: variant.selectedOptions, inventoryPolicy: variant.inventoryPolicy, inventoryItem: variant.inventoryItem,
      mediaIds: variant.mediaIds })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export async function readAdoptionProduct(client, id, { inventory = true } = {}) {
  assert(gid(id, 'Product'), 'A reviewed Shopify product GID is required');
  const data = (await client.request(PRODUCT_READ, { id })).product;
  assert(data?.id === id && ['ACTIVE', 'DRAFT'].includes(data.status) && data.variants?.pageInfo?.hasNextPage === false && data.media?.pageInfo?.hasNextPage === false,
    'Complete current Shopify product identity is required');
  const product = { id: data.id, handle: data.handle, status: data.status, title: data.title, descriptionHtml: data.descriptionHtml,
    vendor: data.vendor, productType: data.productType, seo: data.seo, metafield: data.metafield || null,
    sourceUuid: data.metafield?.value || null, variants: data.variants.nodes.map(variant => ({ ...variant })),
    media: data.media.nodes.map(media => ({ id: media.id, mediaContentType: media.mediaContentType, status: media.status,
      alt: media.alt, url: media.image?.url || null, width: media.image?.width || null, height: media.image?.height || null })) };
  assert(product.variants.length > 0 && new Set(product.variants.map(variant => variant.id)).size === product.variants.length, 'Shopify variant identities are invalid');
  for (let offset = 0; offset < product.variants.length; offset += 5) {
    const batch = product.variants.slice(offset, offset + 5);
    const response = await client.request(ASSOCIATIONS_READ, { ids: batch.map(variant => variant.id) });
    const quantities = inventory ? await client.request(INVENTORY_READ, { ids: batch.map(variant => variant.inventoryItem.id) }) : null;
    assert(response.nodes?.length === batch.length && (!inventory || quantities.nodes?.length === batch.length), 'Shopify variant readback is incomplete');
    for (const variant of batch) {
      const media = response.nodes.find(row => row?.id === variant.id)?.media;
      assert(media?.pageInfo?.hasNextPage === false, 'Complete variant-media readback is required');
      variant.mediaIds = media.nodes.map(row => row.id);
      if (inventory) {
        const item = quantities.nodes.find(row => row?.id === variant.inventoryItem.id);
        assert(item?.sku === variant.sku && item.inventoryLevels?.pageInfo?.hasNextPage === false, 'Complete inventory ownership readback is required');
        variant.inventoryLevels = item.inventoryLevels.nodes.map(level => ({ id: level.id, location: level.location,
          quantities: level.quantities.slice().sort((a, b) => a.name.localeCompare(b.name)) })).sort((a, b) => a.id.localeCompare(b.id));
      }
    }
  }
  return product;
}

function verifySourceVariants(style, product) {
  assert(product.variants.length === style.variants.length, 'Actual variant set differs from reviewed source');
  for (const variant of style.variants) {
    const rows = product.variants.filter(row => row.sku === variant.sku), row = rows[0];
    assert(rows.length === 1 && gid(row.id, 'ProductVariant') && gid(row.inventoryItem?.id, 'InventoryItem') && row.selectedOptions?.length === 2 &&
      row.selectedOptions.some(option => /^(?:color|colour)$/i.test(option.name) && option.value === variant.color) &&
      row.selectedOptions.some(option => /^size$/i.test(option.name) && option.value === variant.size), 'Real SKU/options/inventory identity differs from reviewed source');
  }
}

export function buildAdoptionPlan(proposal, snapshot, products) {
  const { proposalSha256, ...unsigned } = proposal || {};
  const { contentSha256, ...source } = snapshot || {};
  assert(proposalSha256 === adoptionHash(unsigned) && proposal.status === 'existing-catalog-adoption-proposal-no-apply' &&
    contentSha256 === adoptionHash(source) && proposal.nativeSnapshotSha256 === adoptionHash(snapshot) && proposal.nativeCatalogContentSha256 === snapshot.contentSha256,
    'Audited proposal/source snapshot hash differs');
  assert(proposal.currency === 'USD' && proposal.pricePolicy === 'source-resale-usd-times-1.5-ceiling-.99' && snapshot.pricePolicy === proposal.pricePolicy &&
    Array.isArray(snapshot.styles) && snapshot.styles.length > 0 && snapshot.styles.length <= 50 && proposal.styles?.length === snapshot.styles.length &&
    proposal.globalSkuCollisions?.length === 0 && products.length === snapshot.styles.length, 'Audited adoption batch is incomplete or ambiguous');
  const styles = snapshot.styles.map(style => {
    const reviewed = proposal.styles.find(row => row.sourceUuid === style.sourceUuid);
    assert(reviewed?.blockingLabels?.length === 0 && reviewed.sourceId === style.sourceId && reviewed.adoptionProposal?.action === 'REVIEW_EXISTING_PRICE_ONLY_ADOPTION_NO_APPLY' &&
      gid(reviewed.existing?.productGid, 'Product'), 'A complete unambiguous reviewed adoption proposal is required');
    const product = products.find(row => row.id === reviewed.existing.productGid);
    assert(product && product.handle === reviewed.existing.handle && product.status === reviewed.existing.status &&
      (!product.sourceUuid || product.sourceUuid === style.sourceUuid) && auditStructureSha256(product) === reviewed.existing.observedStructureSha256,
      'Current Shopify resource differs from the original audited proposal');
    verifySourceVariants(style, product);
    assert(reviewed.variants.length === style.variants.length && style.variants.every(variant => reviewed.variants.some(row => row.sourceVariantUuid === variant.uuid &&
      row.sku === variant.sku && row.expectedColor === variant.color && row.expectedSize === variant.size &&
      row.variantGid === product.variants.find(actual => actual.sku === variant.sku)?.id &&
      row.inventoryItemGid === product.variants.find(actual => actual.sku === variant.sku)?.inventoryItem?.id)), 'Audited variant/source association differs');
    return { sourceUuid: style.sourceUuid, sourceId: style.sourceId, nativeHandle: style.handle, category: style.category,
      sourceIdentitySha256: sourceIdentitySha256(style), productGid: product.id, handle: product.handle, status: product.status,
      auditStructureSha256: reviewed.existing.observedStructureSha256, frozenProjection: priceIdentityProjection(product),
      variants: style.variants.map(variant => { const row = product.variants.find(actual => actual.sku === variant.sku); return {
        uuid: variant.uuid, sku: variant.sku, color: variant.color, size: variant.size, variantGid: row.id,
        inventoryItemGid: row.inventoryItem.id, imageHashes: variant.imageHashes }; }) };
  });
  const plan = { schemaVersion: 1, mode: ADOPTED_PRICE_ONLY, shop: proposal.shop, auditedProposalSha256: proposalSha256,
    nativeSnapshotSha256: proposal.nativeSnapshotSha256, styles };
  return { ...plan, preparedSha256: adoptionHash(plan) };
}

export async function verifyPriceIdentity({ client, mapping, style = null, mappingStore = null }) {
  assert(mapping && gid(mapping.productGid, 'Product') && typeof mapping.sourceUuid === 'string' && Array.isArray(mapping.variants), 'A complete product price mapping is required');
  if (mappingStore) await assertNoUnresolvedOperations(mappingStore);
  const product = await readAdoptionProduct(client, mapping.productGid, { inventory: false });
  assert(product.sourceUuid === mapping.sourceUuid && product.handle === mapping.handle && product.variants.length === mapping.variants.length, 'Live Shopify price ownership or handle differs');
  const source = style || { variants: mapping.variants };
  if (style && mapping.mode === ADOPTED_PRICE_ONLY) assert(sourceIdentitySha256(style) === mapping.sourceIdentitySha256, 'Adopted native source identity changed');
  verifySourceVariants(source, product);
  for (const variant of mapping.variants) {
    const live = product.variants.find(row => row.sku === variant.sku);
    assert(live?.id === variant.variantGid && live.inventoryItem?.id === variant.inventoryItemGid, 'Live Shopify variant/inventory identifiers differ');
  }
  // JSONB persistence can reorder object keys; arrays and values remain exact.
  if (mapping.mode === ADOPTED_PRICE_ONLY) assert(isDeepStrictEqual(priceIdentityProjection(product), mapping.frozenProjection), 'Adopted Shopify projection drift requires review');
  await assertGlobalSkuOwnership({ client, style: source, productId: mapping.productGid });
  await assertGlobalSourceOwnership({ client, sourceUuid: mapping.sourceUuid, productId: mapping.productGid });
  return product;
}

export function createCatalogAdopter({ client, mappingStore, now = Date.now }) {
  for (const method of ['withLock', 'getProduct', 'saveProduct', 'getOperation', 'saveOperation', 'listUnresolvedOperations']) assert(typeof mappingStore?.[method] === 'function', `Adoption repository requires ${method}`);
  return {
    async prepare({ proposal, snapshot }) {
      await assertNoUnresolvedOperations(mappingStore);
      const currency = await client.request('query BridgeAdoptionCurrency{shop{currencyCode}}');
      assert(currency.shop?.currencyCode === 'USD', 'Shopify native currency must be USD');
      const owners = await pages(client, OWNER_READ, {}, data => data.products);
      const products = [];
      for (const style of snapshot.styles) {
        const reviewed = proposal.styles?.find(row => row.sourceUuid === style.sourceUuid);
        assert(reviewed?.existing?.productGid, 'Reviewed existing resource is missing');
        const existing = await mappingStore.getProduct(style.sourceUuid);
        assert(!existing, 'Source already has a product mapping; use its original adoption result');
        assert(!owners.some(product => product.metafield?.value === style.sourceUuid && product.id !== reviewed.existing.productGid), 'Another Shopify product owns this source UUID');
        await assertGlobalSkuOwnership({ client, style, productId: reviewed.existing.productGid });
        products.push(await readAdoptionProduct(client, reviewed.existing.productGid));
      }
      return buildAdoptionPlan(proposal, snapshot, products);
    },
    async apply(plan, { reviewedSha256 } = {}) {
      const { preparedSha256, ...unsigned } = plan || {};
      assert(plan?.mode === ADOPTED_PRICE_ONLY && preparedSha256 === reviewedSha256 && adoptionHash(unsigned) === preparedSha256 &&
        plan.styles?.length > 0 && plan.styles.length <= 50 && (!client.shop || plan.shop === client.shop), 'Reviewed adoption plan hash/shop differs');
      // A later style may have lost its response after earlier styles completed.
      // Inspect every original pending result before allowing even a new CAS in
      // this batch. Keep the same plan/intent; do not rebase or silently clear it.
      const recoveredKeys = [];
      for (const pending of await mappingStore.listUnresolvedOperations()) {
        const style = plan.styles.find(row => pending.key === `adopt-owner:${row.sourceUuid}:${preparedSha256}`);
        assert(style, 'An existing sent/unknown Shopify operation belongs to another original plan');
        const input = [{ ownerId: style.productGid, namespace: 'shusha_bridge', key: 'source_uuid', type: 'single_line_text_field', value: style.sourceUuid, compareDigest: null }];
        assert(pending.record?.inputHash === adoptionHash(input) && pending.record?.planSha256 === preparedSha256,
          'Original adoption CAS input differs');
        const observed = await readAdoptionProduct(client, style.productGid);
        assert(observed.sourceUuid === style.sourceUuid && auditStructureSha256(observed) === style.auditStructureSha256,
          'Unresolved adoption CAS lacks its original exact result; no blind retry');
        recoveredKeys.push(pending.key);
      }
      const result = [];
      for (const style of plan.styles) result.push(await mappingStore.withLock(`product:${style.sourceUuid}`, async () => {
        const operationKey = `adopt-owner:${style.sourceUuid}:${preparedSha256}`;
        await assertNoUnresolvedOperations(mappingStore, recoveredKeys);
        const saved = await mappingStore.getProduct(style.sourceUuid);
        const previous = await mappingStore.getOperation(operationKey);
        assert(!saved || saved.mode === ADOPTED_PRICE_ONLY && saved.auditedProposalSha256 === plan.auditedProposalSha256 && saved.adoptionPlanSha256 === preparedSha256,
          'Existing mapping belongs to another adoption intent');
        const product = await readAdoptionProduct(client, style.productGid);
        assert(auditStructureSha256(product) === style.auditStructureSha256 && (!product.sourceUuid || product.sourceUuid === style.sourceUuid), 'Original adoption projection or owner changed');
        await assertGlobalSkuOwnership({ client, style, productId: style.productGid });
        await assertGlobalSourceOwnership({ client, sourceUuid: style.sourceUuid, productId: style.productGid, allowMissing: true });
        const input = [{ ownerId: style.productGid, namespace: 'shusha_bridge', key: 'source_uuid', type: 'single_line_text_field', value: style.sourceUuid, compareDigest: null }];
        const inputHash = adoptionHash(input);
        assert(!previous || previous.inputHash === inputHash && previous.planSha256 === preparedSha256, 'Original adoption CAS input differs');
        if (!product.sourceUuid) {
          assert(!unresolved(previous), 'Unresolved adoption CAS must be independently read back; no blind retry');
          const intent = { status: 'sent', input, inputHash, planSha256: preparedSha256, sentAt: new Date(now()).toISOString() };
          await mappingStore.saveOperation(operationKey, intent);
          try {
            const response = await client.request(OWNER_WRITE, { metafields: input }, { kind: 'mutation' });
            assert(response.metafieldsSet && Array.isArray(response.metafieldsSet.userErrors) && response.metafieldsSet.userErrors.length === 0,
              'Source UUID CAS rejected; preserve the original intent for review');
          } catch (error) {
            await mappingStore.saveOperation(operationKey, { ...intent, status: error instanceof UnknownMutationOutcomeError ? 'unknown' : 'failed', errorCode: error.code || 'SHOPIFY_ADOPTION_CAS_REVIEW' });
            throw error;
          }
        } else assert(previous || !saved, 'Owned mapping lost its original adoption journal');
        const after = await readAdoptionProduct(client, style.productGid);
        assert(after.sourceUuid === style.sourceUuid && auditStructureSha256(after) === style.auditStructureSha256,
          'Adoption CAS requires exact original-resource readback');
        const mapping = { ...style, mode: ADOPTED_PRICE_ONLY, auditedProposalSha256: plan.auditedProposalSha256,
          adoptionPlanSha256: preparedSha256, adoptedAt: saved?.adoptedAt || new Date(now()).toISOString() };
        await mappingStore.saveProduct(style.sourceUuid, mapping);
        const retainedIntent = await mappingStore.getOperation(operationKey);
        await mappingStore.saveOperation(operationKey, { ...(retainedIntent || previous || {}), input, inputHash, planSha256: preparedSha256,
          status: 'complete', completedAt: new Date(now()).toISOString(), originalResultReadBack: true });
        return { sourceUuid: style.sourceUuid, status: saved ? 'already-adopted' : 'adopted-price-only', markerWritten: !product.sourceUuid };
      }));
      return { status: 'existing-products-adopted-price-only', adopted: result.filter(row => row.status === 'adopted-price-only').length,
        existing: result.filter(row => row.status === 'already-adopted').length, priceWrites: 0, inventoryWrites: 0, publicationWrites: 0, results: result };
    }
  };
}
