import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { normalizeRules, retailCents } from '../../../retail-pricing/src/services/pricing.js';
import { UnknownMutationOutcomeError } from './shopifyClient.js';

const pricing = normalizeRules({ enabled: true, multiplier: '1.1' });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function retailUsd(sourceUsd) {
  assert(/^\d{1,8}(?:\.\d{1,4})?$/.test(String(sourceUsd)) && Number(sourceUsd) > 0, 'Invalid positive source Resale USD price');
  const cents = retailCents(sourceUsd, pricing);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

const htmlOptions = { allowedTags: ['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a'], allowedAttributes: { a: ['href'] }, allowedSchemes: ['https', 'mailto'], allowProtocolRelative: false };
export function safeDescription(value) {
  if (value === null || value === undefined || value === '') return '';
  assert(typeof value === 'string' && Buffer.byteLength(value) <= 256 * 1024, 'Description is not bounded text');
  let html = value;
  if (value.trim().startsWith('[')) {
    let rows;
    try { rows = JSON.parse(value); } catch (_) { throw new Error('Native editor description is invalid'); }
    assert(Array.isArray(rows), 'Native editor description must be rows');
    const blocks = rows.flatMap((row) => (row.columns || []).flatMap((column) => column.data?.blocks || []));
    assert(blocks.length <= 200 && blocks.every((block) => ['raw', 'paragraph', 'header', 'list'].includes(block.type)), 'Description contains unsupported native editor blocks');
    html = blocks.map((block) => {
      if (block.type === 'raw') return block.data.html || '';
      if (block.type === 'paragraph') return `<p>${block.data.text || ''}</p>`;
      if (block.type === 'header') return `<h3>${block.data.text || ''}</h3>`;
      const tag = block.data.style === 'ordered' ? 'ol' : 'ul';
      assert(Array.isArray(block.data.items) && block.data.items.every((item) => typeof item === 'string'), 'Unsupported nested editor list');
      return `<${tag}>${block.data.items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`;
    }).join('\n');
  }
  return sanitizeHtml(html, htmlOptions);
}

export async function readVerifiedImage(asset, mediaRoot) {
  assert(asset && /^[a-f0-9]{64}$/.test(asset.sha256 || '') && /^media\/source-library\/[a-f0-9]{64}\.(?:png|jpe?g|webp)$/.test(asset.localPath || ''), 'Image must be a reviewed content-addressed original');
  assert(path.basename(asset.localPath).split('.')[0] === asset.sha256 && Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= 20 * 1024 * 1024, 'Image hash filename or bounded size is invalid');
  const root = await fs.realpath(mediaRoot);
  const filename = path.resolve(root, path.basename(asset.localPath));
  const stat = await fs.lstat(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.bytes && (await fs.realpath(filename)).startsWith(`${root}${path.sep}`), 'Original image is missing, changed, or outside the managed directory');
  const bytes = await fs.readFile(filename);
  assert(hash(bytes) === asset.sha256, 'Original image content hash differs');
  const ext = path.extname(filename).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const signature = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  assert(signature, 'Original image signature differs from its extension');
  return { bytes, mimeType, filename: `shusha-${asset.sha256}${ext}` };
}

// Dedicated caller connection. No customers/orders or SELECT * are exported.
// A repeatable-read snapshot and existing job locks keep map/price facts coherent.
export async function buildCatalogSnapshot({ db, storeMap, mediaIndex, mediaRoot, now = () => new Date() }) {
  assert(storeMap?.schemaVersion === 1 && Array.isArray(storeMap.mappings) && mediaIndex?.schemaVersion === 1 && Array.isArray(mediaIndex.assets), 'Catalog map/media manifest schema is invalid');
  const mapping = new Map();
  for (const row of storeMap.mappings) {
    assert(/^L\d{3,8}$/.test(row.sourceId || '') && row.priceBasis === 'site-resale-display' && row.storeSku?.startsWith(`SHUSHA-${row.sourceId}`) && !mapping.has(row.storeSku), 'Store map is ambiguous');
    mapping.set(row.storeSku, row);
  }
  const indexed = new Map(mediaIndex.assets.map((asset) => [asset.localPath, asset]));
  const locks = []; let transaction = false;
  try {
    for (const key of ['shusha-material-publication-v1', 'shusha-source-price-sync-v1']) {
      assert((await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])).rows[0]?.locked === true, 'Catalog writer is active; export postponed');
      locks.push(key);
    }
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    const publications = (await db.query("SELECT source_id,anchor_sku,group_id,plan,created_at FROM shusha_material_publication WHERE status='complete' ORDER BY created_at,source_id")).rows;
    const products = (await db.query(`SELECT p.product_id,p.uuid,p.sku,p.price,p.variant_group_id,p.visibility,p.status,p.created_at,
      d.name,d.description,d.url_key,d.meta_title,d.meta_description,i.qty
      FROM product p JOIN product_description d ON d.product_description_product_id=p.product_id
      JOIN product_inventory i ON i.product_inventory_product_id=p.product_id
      WHERE p.sku=ANY($1::text[]) OR p.variant_group_id=ANY($2::int[]) ORDER BY p.product_id`, [[...mapping.keys()], publications.map((row) => row.group_id)])).rows;
    const ids = products.map((row) => row.product_id);
    const attributes = (await db.query(`SELECT v.product_id,a.attribute_code,v.option_text FROM product_attribute_value_index v
      JOIN attribute a ON a.attribute_id=v.attribute_id WHERE v.product_id=ANY($1::int[]) AND a.attribute_code=ANY($2::text[])`, [ids, ['shusha_color', 'shusha_size']])).rows;
    const gallery = (await db.query('SELECT product_image_product_id,origin_image,is_main,product_image_id FROM product_image WHERE product_image_product_id=ANY($1::int[]) ORDER BY product_image_id', [ids])).rows;
    const styles = [];
    for (const publication of publications) {
      const plan = publication.plan;
      assert(plan?.sourceId === publication.source_id && Array.isArray(plan.variants) && plan.variants.length > 0, 'Completed publication plan is invalid');
      const anchor = products.find((row) => row.sku === publication.anchor_sku);
      if (!anchor || anchor.status !== true || anchor.visibility !== true) continue;
      assert(plan.review?.ready === true && Number.isFinite(Date.parse(plan.review.reviewedAt)) && /^[a-f0-9]{64}$/.test(plan.review.reviewedSourceSha256 || ''), 'Published material lacks explicit visual review evidence');
      assert(['dresses', 'tops', 'pants'].includes(plan.category) && anchor.sku === `SHUSHA-${plan.sourceId}` && anchor.url_key === plan.sourceId.toLowerCase(), 'Published style ownership or canonical route differs');
      const variants = []; const images = new Map(); const options = new Set();
      for (const expected of plan.variants) {
        const sourceMap = mapping.get(expected.storeSku);
        const live = products.filter((row) => row.sku === expected.storeSku);
        assert(sourceMap?.sourceId === plan.sourceId && sourceMap.sourceVariantSku === expected.sourceVariantSku && live.length === 1, 'Current map and completed publication differ');
        const row = live[0];
        assert(row.status === true && row.variant_group_id === publication.group_id && row.url_key === sourceMap.storeUrlKey && uuidPattern.test(row.uuid), 'Actual published variant differs from map');
        const actualAttributes = attributes.filter((value) => value.product_id === row.product_id);
        assert(actualAttributes.length === 2 && actualAttributes.some((value) => value.attribute_code === 'shusha_color' && value.option_text === expected.color) && actualAttributes.some((value) => value.attribute_code === 'shusha_size' && value.option_text === expected.size), 'Actual colour/size differs from reviewed variant');
        const combination = JSON.stringify([expected.color, expected.size]);
        assert(!options.has(combination), 'Duplicate actual colour/size variant'); options.add(combination);
        const actualGallery = gallery.filter((image) => image.product_image_product_id === row.product_id);
        assert(actualGallery.length === expected.images.length && actualGallery.filter((image) => image.is_main).length === 1 && expected.images.every((image) => actualGallery.some((actual) => actual.origin_image === image.assetUrl)), 'Actual gallery differs from reviewed original images');
        for (const image of expected.images) {
          const asset = indexed.get(image.localPath);
          assert(asset?.sha256 === image.sha256 && asset.bytes === image.bytes, 'Media manifest differs from published image');
          await readVerifiedImage(asset, mediaRoot);
          images.set(asset.sha256, { sha256: asset.sha256, localPath: asset.localPath, bytes: asset.bytes, alt: `${anchor.name} — ${expected.color}`, width: asset.width, height: asset.height });
        }
        assert(Number.isSafeInteger(row.qty), 'Actual remaining request capacity is invalid');
        variants.push({ uuid: row.uuid, sku: row.sku, sourceVariantSku: sourceMap.sourceVariantSku, color: expected.color, size: expected.size,
          sourceUsd: String(row.price), retailUsd: retailUsd(String(row.price)), remainingCapacity: row.qty, imageHashes: expected.images.map((image) => image.sha256) });
      }
      assert(products.filter((row) => row.variant_group_id === publication.group_id).length === variants.length, 'Published variant group contains unmapped variants');
      styles.push({ sourceId: plan.sourceId, sourceUuid: anchor.uuid, handle: plan.sourceId.toLowerCase(), category: plan.category, title: anchor.name,
        descriptionHtml: safeDescription(anchor.description), seo: { title: anchor.meta_title || anchor.name, description: anchor.meta_description || '' },
        canonicalPath: `/${plan.category}/${anchor.url_key}`, publishedAt: new Date(publication.created_at).toISOString(), variants, images: [...images.values()] });
    }
    await db.query('COMMIT'); transaction = false;
    const snapshot = { schemaVersion: 1, currency: 'USD', pricePolicy: 'source-resale-usd-times-1.1-ceiling-.99', capturedAt: now().toISOString(), styles };
    return { ...snapshot, contentSha256: hash(JSON.stringify(snapshot)) };
  } catch (error) { if (transaction) await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { for (const key of locks.reverse()) await db.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
}

const selection = `id handle status metafield(namespace:"shusha_bridge",key:"source_uuid"){value}
 media(first:250){nodes{id} pageInfo{hasNextPage}}
 variants(first:100){nodes{id sku price selectedOptions{name value} inventoryItem{id}} pageInfo{hasNextPage}}`;
const findProduct = `query BridgeProduct($identifier:ProductIdentifierInput!){productByIdentifier(identifier:$identifier){${selection}}}`;
const createProduct = `mutation BridgeDraft($input:ProductSetInput!,$identifier:ProductSetIdentifiers!){productSet(input:$input,identifier:$identifier,synchronous:true){product{${selection}} userErrors{code field}}}`;
const updatePrices = `mutation BridgePrices($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){productVariants{id price} userErrors{code field}}}`;
const findFiles = 'query BridgeFiles($query:String!){files(first:3,query:$query){nodes{id fileStatus ... on MediaImage{image{url}}}}}';
const stageFiles = 'mutation BridgeStage($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}} userErrors{field}}}';
const createFile = 'mutation BridgeFile($files:[FileCreateInput!]!){fileCreate(files:$files){files{id fileStatus} userErrors{code field}}}';
const getFile = 'query BridgeFileStatus($id:ID!){node(id:$id){... on MediaImage{id fileStatus image{url}}}}';
const getVariantMedia = 'query BridgeVariantMedia($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id media(first:24){nodes{id} pageInfo{hasNextPage}}}}}';
const appendVariantMedia = 'mutation BridgeVariantMediaAttach($productId:ID!,$variantMedia:[ProductVariantAppendMediaInput!]!){productVariantAppendMedia(productId:$productId,variantMedia:$variantMedia){product{id} userErrors{code field}}}';

export function validateCatalogSnapshot(snapshot) {
  assert(snapshot?.schemaVersion === 1 && snapshot.currency === 'USD' && snapshot.pricePolicy === 'source-resale-usd-times-1.1-ceiling-.99' && Array.isArray(snapshot.styles) && snapshot.styles.length <= 1000, 'Unsupported catalog snapshot');
  const { contentSha256, ...unsigned } = snapshot;
  assert(contentSha256 === hash(JSON.stringify(unsigned)), 'Private catalog snapshot hash differs');
  const handles = new Set(); const skus = new Set(); const uuids = new Set();
  for (const style of snapshot.styles) {
    assert(/^L\d{3,8}$/.test(style.sourceId) && style.handle === style.sourceId.toLowerCase() && uuidPattern.test(style.sourceUuid) && !handles.has(style.handle), 'Catalog style identity is invalid'); handles.add(style.handle);
    assert(typeof style.title === 'string' && style.title.length > 0 && style.title.length <= 300 && ['dresses', 'pants', 'tops'].includes(style.category) && style.descriptionHtml === safeDescription(style.descriptionHtml), 'Catalog title/category/safe HTML is invalid');
    assert(Array.isArray(style.variants) && style.variants.length > 0 && style.variants.length <= 100 && Array.isArray(style.images) && style.images.length > 0 && style.images.length <= 250, 'Catalog variant/image bounds invalid');
    const imageHashes = new Set(style.images.map((image) => image.sha256));
    assert(imageHashes.size === style.images.length, 'Duplicate catalog original image');
    const combinations = new Set();
    for (const variant of style.variants) {
      assert(uuidPattern.test(variant.uuid) && !uuids.has(variant.uuid) && typeof variant.sku === 'string' && (variant.sku === `SHUSHA-${style.sourceId}` || variant.sku === `SHUSHA-${style.sourceId}-V-${variant.sourceVariantSku}`) && !skus.has(variant.sku), 'Catalog variant identity is invalid');
      uuids.add(variant.uuid); skus.add(variant.sku);
      assert([variant.color, variant.size].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f<>]/.test(value)), 'Catalog real colour/size is invalid');
      const combination = JSON.stringify([variant.color, variant.size]); assert(!combinations.has(combination), 'Duplicate real colour/size'); combinations.add(combination);
      assert(variant.retailUsd === retailUsd(variant.sourceUsd) && Number.isSafeInteger(variant.remainingCapacity) && Array.isArray(variant.imageHashes) && variant.imageHashes.length > 0 && variant.imageHashes.every((value) => imageHashes.has(value)), 'Catalog variant price/image mapping differs');
    }
    assert(style.variants.some((variant) => variant.uuid === style.sourceUuid && variant.sku === `SHUSHA-${style.sourceId}`), 'Catalog anchor UUID differs');
  }
  return snapshot;
}

function structuralHash(style) {
  return hash(JSON.stringify({ sourceUuid: style.sourceUuid, handle: style.handle, category: style.category, title: style.title, descriptionHtml: style.descriptionHtml,
    variants: style.variants.map(({ uuid, sku, color, size, imageHashes }) => ({ uuid, sku, color, size, imageHashes })), images: style.images.map(({ sha256 }) => sha256) }));
}
function userErrors(payload, operation) { assert(payload && Array.isArray(payload.userErrors) && payload.userErrors.length === 0, `Shopify ${operation} rejected; inspect private journal`); }

function mapProduct(style, product, media) {
  assert(product && /^gid:\/\/shopify\/Product\/\d+$/.test(product.id) && product.handle === style.handle && product.metafield?.value === style.sourceUuid && product.variants?.pageInfo?.hasNextPage === false, 'Shopify product identity cannot be reconciled');
  const nodes = product.variants.nodes;
  assert(nodes.length === style.variants.length && new Set(nodes.map((node) => node.sku)).size === nodes.length, 'Shopify variant set differs from actual published styles');
  if (media) {
    assert(product.media?.pageInfo?.hasNextPage === false && product.media.nodes.length === style.images.length && product.media.nodes.every((node, index) => node.id === media.get(style.images[index].sha256)?.gid), 'Shopify product original-image order differs');
  }
  const variants = style.variants.map((variant) => {
    const node = nodes.find((value) => value.sku === variant.sku);
    assert(node && node.selectedOptions.length === 2 && node.selectedOptions.some((value) => value.name === 'Color' && value.value === variant.color) && node.selectedOptions.some((value) => value.name === 'Size' && value.value === variant.size) && /^gid:\/\/shopify\/InventoryItem\/\d+$/.test(node.inventoryItem?.id), 'Shopify SKU/options/inventory ownership differs');
    return { uuid: variant.uuid, sku: variant.sku, variantGid: node.id, inventoryItemGid: node.inventoryItem.id, price: String(node.price), imageHashes: variant.imageHashes };
  });
  return { productGid: product.id, sourceUuid: style.sourceUuid, handle: style.handle, structureSha256: structuralHash(style), variants };
}

export function createCatalogImporter({ client, mappingStore, mediaRoot, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  for (const method of ['withLock', 'getProduct', 'saveProduct', 'getMedia', 'saveMedia', 'getOperation', 'saveOperation']) assert(typeof mappingStore[method] === 'function', `Catalog repository requires ${method}`);
  const operation = async (key, input, fn) => {
    const previous = await mappingStore.getOperation(key);
    const inputHash = hash(JSON.stringify(input));
    assert(!previous || previous.inputHash === inputHash, 'Frozen Shopify operation input differs');
    assert(!previous || !['unknown', 'sent'].includes(previous.status), 'Unresolved Shopify operation requires readback before retry');
    await mappingStore.saveOperation(key, { inputHash, input, status: 'sent', sentAt: new Date(now()).toISOString() });
    try {
      const result = await fn();
      await mappingStore.saveOperation(key, { inputHash, status: 'complete', completedAt: new Date(now()).toISOString() });
      return result;
    } catch (error) {
      await mappingStore.saveOperation(key, { inputHash, input, status: error instanceof UnknownMutationOutcomeError ? 'unknown' : 'failed', errorCode: error.code || 'SHOPIFY_CATALOG_FAILED', sentAt: previous?.sentAt || new Date(now()).toISOString() });
      throw error;
    }
  };
  async function ensureMedia(asset) {
    return mappingStore.withLock(`media:${asset.sha256}`, async () => {
      const original = await readVerifiedImage(asset, mediaRoot);
      let saved = await mappingStore.getMedia(asset.sha256);
      if (!saved) {
        const result = await client.request(findFiles, { query: `filename:"${original.filename}"` });
        assert(result.files.nodes.length <= 1, 'Shopify original-image filename is ambiguous');
        if (result.files.nodes.length) saved = { gid: result.files.nodes[0].id, sha256: asset.sha256, filename: original.filename };
      }
      if (!saved) {
        const key = `media-create:${asset.sha256}`;
        const unresolved = await mappingStore.getOperation(key);
        assert(!unresolved || !['sent', 'unknown'].includes(unresolved.status), 'Original image upload outcome unresolved; reconcile before retry');
        const staging = await client.request(stageFiles, { input: [{ filename: original.filename, mimeType: original.mimeType, resource: 'IMAGE', httpMethod: 'POST', fileSize: String(asset.bytes) }] }, { kind: 'mutation' });
        userErrors(staging.stagedUploadsCreate, 'image staging');
        assert(staging.stagedUploadsCreate.stagedTargets.length === 1, 'Shopify did not stage one original image');
        const target = staging.stagedUploadsCreate.stagedTargets[0];
        await client.uploadStaged(target, original.bytes, original);
        const files = [{ originalSource: target.resourceUrl, contentType: 'IMAGE', filename: original.filename, duplicateResolutionMode: 'RAISE_ERROR', alt: asset.alt }];
        const created = await operation(key, files, async () => {
          const result = await client.request(createFile, { files }, { kind: 'mutation' });
          userErrors(result.fileCreate, 'original image creation');
          return result;
        });
        assert(created.fileCreate.files.length === 1, 'Shopify did not create one original image');
        saved = { gid: created.fileCreate.files[0].id, sha256: asset.sha256, filename: original.filename };
      }
      assert(/^gid:\/\/shopify\/MediaImage\/\d+$/.test(saved.gid) && saved.sha256 === asset.sha256 && saved.filename === original.filename, 'Shopify media mapping differs');
      await mappingStore.saveMedia(asset.sha256, saved);
      for (let attempt = 0; attempt < 12; attempt++) {
        const current = (await client.request(getFile, { id: saved.gid })).node;
        assert(current && current.fileStatus !== 'FAILED', 'Shopify original image processing failed');
        if (current.fileStatus === 'READY' && current.image?.url) return saved;
        if (attempt < 11) await sleep(2000);
      }
      throw new Error('Shopify original image is not READY; draft attachment postponed');
    });
  }
  async function pricesOnly(style, saved, product) {
    const media = new Map();
    for (const image of style.images) {
      const mapped = await mappingStore.getMedia(image.sha256);
      assert(mapped?.sha256 === image.sha256 && /^gid:\/\/shopify\/MediaImage\/\d+$/.test(mapped.gid), 'Private original-image mapping is missing');
      media.set(image.sha256, mapped);
    }
    await ensureVariantMedia(style, product, media, false);
    const actual = mapProduct(style, product, media);
    assert(saved.productGid === actual.productGid && saved.structureSha256 === structuralHash(style) && actual.variants.every((variant) => saved.variants.some((old) => old.uuid === variant.uuid && old.variantGid === variant.variantGid && old.inventoryItemGid === variant.inventoryItemGid)), 'Mapped Shopify product structure changed; full replacement is refused');
    const changed = style.variants.filter((variant) => Number(actual.variants.find((row) => row.sku === variant.sku).price) !== Number(variant.retailUsd));
    if (changed.length) {
      const variants = changed.map((variant) => ({ id: actual.variants.find((row) => row.sku === variant.sku).variantGid, price: variant.retailUsd }));
      const result = await client.request(updatePrices, { productId: saved.productGid, variants }, { kind: 'mutation' });
      userErrors(result.productVariantsBulkUpdate, 'price update');
      assert(result.productVariantsBulkUpdate.productVariants.length === variants.length && variants.every((row) => result.productVariantsBulkUpdate.productVariants.some((actualRow) => actualRow.id === row.id && Number(actualRow.price) === Number(row.price))), 'Shopify price update readback differs');
    }
    return { status: changed.length ? 'prices-updated' : 'unchanged', changedPrices: changed.length };
  }
  async function ensureVariantMedia(style, product, media, allowWrites = true) {
    const record = mapProduct(style, product, media);
    const missing = [];
    for (let offset = 0; offset < record.variants.length; offset += 20) {
      const batch = record.variants.slice(offset, offset + 20);
      const response = await client.request(getVariantMedia, { ids: batch.map((row) => row.variantGid) });
      assert(response.nodes.length === batch.length, 'Shopify variant media readback is incomplete');
      for (const variant of batch) {
        const actual = response.nodes.find((row) => row?.id === variant.variantGid);
        const expected = variant.imageHashes.map((value) => media.get(value).gid);
        assert(actual?.media?.pageInfo?.hasNextPage === false && actual.media.nodes.every((node) => expected.includes(node.id)), 'Shopify variant has unrelated or unbounded media');
        const absent = expected.filter((gid) => !actual.media.nodes.some((node) => node.id === gid));
        if (absent.length) missing.push({ variantId: variant.variantGid, mediaIds: absent });
      }
    }
    if (!missing.length) return;
    assert(allowWrites, 'Mapped Shopify variant original-image association changed; price-only sync refused');
    const key = `variant-media:${style.sourceUuid}:${structuralHash(style)}`;
    await operation(key, missing, async () => {
      const result = await client.request(appendVariantMedia, { productId: product.id, variantMedia: missing }, { kind: 'mutation' });
      userErrors(result.productVariantAppendMedia, 'variant original-image association');
      return result;
    });
    await ensureVariantMedia(style, product, media, false);
  }
  return {
    async importSnapshot(snapshot, { apply = false } = {}) {
      validateCatalogSnapshot(snapshot);
      if (!apply) return { status: 'dry-run', styles: snapshot.styles.length, variants: snapshot.styles.reduce((count, style) => count + style.variants.length, 0), currency: 'USD', remoteWrites: false };
      const shop = await client.request('query BridgeCurrency{shop{currencyCode}}');
      assert(shop.shop.currencyCode === 'USD', 'Set the target Shopify store currency to USD before importing');
      const results = [];
      for (const style of snapshot.styles) {
        results.push(await mappingStore.withLock(`product:${style.sourceUuid}`, async () => {
          const saved = await mappingStore.getProduct(style.sourceUuid);
          const found = (await client.request(findProduct, { identifier: { handle: style.handle } })).productByIdentifier;
          if (saved) { assert(found, 'Mapped Shopify product is missing; refusing recreation'); return pricesOnly(style, saved, found); }
          if (found) {
            // Handles are reserved only for our explicit UUID ownership marker.
            assert(found.status === 'DRAFT', 'Unmapped Shopify product is already active; merchant review required');
            const recoveredMedia = new Map();
            for (const image of style.images) recoveredMedia.set(image.sha256, await ensureMedia(image));
            await ensureVariantMedia(style, found, recoveredMedia);
            const recovered = mapProduct(style, found, recoveredMedia);
            await mappingStore.saveProduct(style.sourceUuid, recovered);
            return pricesOnly(style, recovered, found);
          }
          const media = new Map();
          for (const image of style.images) media.set(image.sha256, await ensureMedia(image));
          const productInput = {
            title: style.title, handle: style.handle, status: 'DRAFT', vendor: 'SHUSHA', productType: style.category,
            descriptionHtml: style.descriptionHtml, seo: style.seo,
            metafields: [{ namespace: 'shusha_bridge', key: 'source_uuid', type: 'single_line_text_field', value: style.sourceUuid }],
            productOptions: ['Color', 'Size'].map((name, index) => ({ name, position: index + 1, values: [...new Set(style.variants.map((variant) => variant[index === 0 ? 'color' : 'size']))].map((value) => ({ name: value })) })),
            files: style.images.map((image) => ({ id: media.get(image.sha256).gid })),
            variants: style.variants.map((variant) => ({ sku: variant.sku, price: variant.retailUsd, inventoryPolicy: 'DENY',
              inventoryItem: { tracked: true, requiresShipping: true }, file: { id: media.get(variant.imageHashes[0]).gid },
              optionValues: [{ optionName: 'Color', name: variant.color }, { optionName: 'Size', name: variant.size }] }))
          };
          // No inventory quantities, source price, bank details, or historical orders.
          const key = `draft-create:${style.sourceUuid}`;
          const result = await operation(key, productInput, async () => {
            const created = await client.request(createProduct, { input: productInput, identifier: { handle: style.handle } }, { kind: 'mutation' });
            userErrors(created.productSet, 'draft creation');
            return created;
          });
          await ensureVariantMedia(style, result.productSet.product, media);
          const record = mapProduct(style, result.productSet.product, media);
          assert(result.productSet.product.status === 'DRAFT', 'Imported product is not a draft');
          await mappingStore.saveProduct(style.sourceUuid, record);
          return { status: 'draft-created', variants: record.variants.length };
        }));
      }
      return { status: 'complete', styles: results.length, draftsCreated: results.filter((row) => row.status === 'draft-created').length, changedPrices: results.reduce((count, row) => count + (row.changedPrices || 0), 0), results };
    }
  };
}

const readInventoryLevel = `query BridgeActivationRead($id:ID!,$location:ID!){inventoryItem(id:$id){id sku tracked
 variant{id product{id}} inventoryLevel(locationId:$location){id item{id} location{id} quantities(names:["available"]){name quantity}}}}`;
const activateMutation = `mutation BridgeActivate($item:ID!,$location:ID!,$key:String!){
 inventoryActivate(inventoryItemId:$item,locationId:$location) @idempotent(key:$key){inventoryLevel{id item{id} location{id}} userErrors{field}}}`;

/** Explicit phase-three setup. Does not set or replenish request capacity. */
export async function activateInventory({ mappingStore, client, locationId, styles, apply = false, now = Date.now }) {
  assert(/^gid:\/\/shopify\/Location\/\d+$/.test(locationId || '') && Array.isArray(styles), 'Reviewed Shopify location and explicit styles are required');
  if (!apply) return { status: 'dry-run', styles: styles.length, remoteWrites: false };
  let activated = 0; let alreadyActive = 0;
  for (const style of styles) {
    await mappingStore.withLock(`product:${style.sourceUuid}`, async () => {
      const mapped = await mappingStore.getProduct(style.sourceUuid);
      assert(mapped?.productGid && mapped.structureSha256 === structuralHash(style), 'Inventory activation requires the exact mapped source style');
      const product = (await client.request(findProduct, { identifier: { id: mapped.productGid } })).productByIdentifier;
      assert(product?.status === 'DRAFT', 'Inventory activation is limited to managed drafts');
      const verified = mapProduct(style, product);
      for (const variant of verified.variants) {
        const liveMapped = mapped.variants.find((row) => row.sku === variant.sku);
        assert(liveMapped?.inventoryItemGid === variant.inventoryItemGid && liveMapped.variantGid === variant.variantGid, 'Inventory activation mapping differs');
        const input = { item: variant.inventoryItemGid, location: locationId };
        const key = `inventory-activate:${variant.inventoryItemGid}:${locationId}`;
        let intent = await mappingStore.getOperation(key);
        const current = (await client.request(readInventoryLevel, { id: input.item, location: locationId })).inventoryItem;
        assert(current?.id === input.item && current.sku === variant.sku && current.tracked === true && current.variant?.product?.id === mapped.productGid && current.variant.id === variant.variantGid, 'Native Shopify inventory item ownership differs');
        if (current.inventoryLevel) {
          assert(current.inventoryLevel.item.id === input.item && current.inventoryLevel.location.id === locationId, 'Shopify inventory location differs');
          if (intent) await mappingStore.saveOperation(key, { ...intent, status: 'complete', reconciledAt: new Date(now()).toISOString() });
          alreadyActive++; continue;
        }
        if (!intent) {
          intent = { input, idempotencyKey: randomUUID(), status: 'prepared', firstSentAt: new Date(now()).toISOString() };
          await mappingStore.saveOperation(key, intent);
        }
        assert(JSON.stringify(intent.input) === JSON.stringify(input), 'Frozen inventory activation input differs');
        if (now() - Date.parse(intent.firstSentAt) >= 23 * 60 * 60 * 1000 + 55 * 60 * 1000) {
          await mappingStore.saveOperation(key, { ...intent, status: 'attention', reason: 'idempotency-window-expired' });
          throw new Error('Inventory activation outcome exceeded its idempotency window; merchant review required');
        }
        assert(intent.status !== 'attention', 'Inventory activation is paused for merchant review');
        await mappingStore.saveOperation(key, { ...intent, status: 'sent' });
        try {
          const result = await client.request(activateMutation, { ...input, key: intent.idempotencyKey }, { kind: 'mutation', safeRetry: true, idempotencyKey: intent.idempotencyKey });
          userErrors(result.inventoryActivate, 'inventory activation');
          assert(result.inventoryActivate.inventoryLevel?.item?.id === input.item && result.inventoryActivate.inventoryLevel.location.id === locationId, 'Inventory activation response ownership differs');
          const readback = (await client.request(readInventoryLevel, { id: input.item, location: locationId })).inventoryItem;
          assert(readback?.inventoryLevel?.item?.id === input.item && readback.inventoryLevel.location.id === locationId, 'Inventory activation readback is incomplete');
          await mappingStore.saveOperation(key, { ...intent, status: 'complete', completedAt: new Date(now()).toISOString() });
          activated++;
        } catch (error) {
          await mappingStore.saveOperation(key, { ...intent, status: error instanceof UnknownMutationOutcomeError ? 'unknown' : 'failed', errorCode: error.code || 'SHOPIFY_ACTIVATION_REVIEW' });
          throw error;
        }
      }
      await mappingStore.saveProduct(style.sourceUuid, { ...mapped, activation: { locationId, completedAt: new Date(now()).toISOString() } });
    });
  }
  return { status: 'complete', activated, alreadyActive, capacityWritten: false };
}

const readPublication = `query BridgePublication($id:ID!,$publication:ID!){product(id:$id){id status
 metafield(namespace:"shusha_bridge",key:"source_uuid"){value} publishedOnPublication(publicationId:$publication)}}`;
const activateProduct = 'mutation BridgeActivateProduct($product:ProductUpdateInput!){productUpdate(product:$product){product{id status} userErrors{field}}}';
const publishProduct = 'mutation BridgePublish($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){userErrors{field}}}';

async function capacityReady(runtime, style, mapped, { locationId }) {
  const skus = style.variants.map((variant) => variant.sku);
  const rows = (await runtime.pool.query(`SELECT b.sku,b.balance,b.shopify_debt,b.frozen,i.qty,
    EXISTS(SELECT 1 FROM shusha_bridge_outbox o WHERE o.aggregate_key=b.sku AND o.state<>'applied') AS unsettled
    FROM shusha_bridge_inventory b JOIN product_inventory i ON i.product_inventory_product_id=b.product_id
    WHERE b.sku=ANY($1::text[]) ORDER BY b.sku`, [skus])).rows;
  if (rows.length !== skus.length) return false;
  for (const row of rows) {
    const balance = Number(row.balance); const debt = Number(row.shopify_debt);
    if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(debt) || row.frozen || row.unsettled || Number(row.qty) !== balance || debt !== Math.max(0, -balance)) return false;
    const variant = mapped.variants.find((value) => value.sku === row.sku);
    const remote = (await runtime.client.request(readInventoryLevel, { id: variant.inventoryItemGid, location: locationId })).inventoryItem;
    const available = remote?.inventoryLevel?.quantities?.find((quantity) => quantity.name === 'available')?.quantity;
    if (remote?.sku !== row.sku || remote.inventoryLevel?.location?.id !== locationId || available !== Math.max(0, balance)) return false;
  }
  return true;
}

/** Reuses the native single cron. Published EverShop styles follow as drafts. */
export function createCatalogFollower(runtime, { env = process.env, snapshotProvider = null, readinessProvider = null, now = Date.now } = {}) {
  const { client, repositories } = runtime;
  const mappingStore = repositories.mappings;
  const mediaRoot = path.resolve(env.MATERIAL_MEDIA_DIR || path.join(process.cwd(), 'media/source-library'));
  const loadSnapshot = snapshotProvider || (async () => {
    const privateRoot = path.resolve(env.PRIVATE_DATA_DIR || path.join(process.cwd(), 'data'));
    const library = path.resolve(env.MATERIAL_LIBRARY_DIR || env.SHUSHA_MATERIAL_LIBRARY_DIR || path.join(privateRoot, 'material-library'));
    const [storeMap, mediaIndex] = await Promise.all(['store-map.json', 'media-index.json'].map(async (name) => JSON.parse(await fs.readFile(path.join(library, name), 'utf8'))));
    const db = await runtime.pool.connect();
    try { return await buildCatalogSnapshot({ db, storeMap, mediaIndex, mediaRoot }); }
    finally { db.release(); }
  });
  return async () => {
    if (env.SHOPIFY_BRIDGE_ENABLED !== 'true' || env.SHOPIFY_BRIDGE_WRITES_ENABLED !== 'true') return { status: 'paused', draftsCreated: 0, published: 0 };
    const snapshot = validateCatalogSnapshot(await loadSnapshot());
    const missing = []; const activation = [];
    for (const style of snapshot.styles) {
      const mapped = await mappingStore.getProduct(style.sourceUuid);
      if (!mapped) missing.push(style);
      if (!mapped?.activation && env.SHOPIFY_INVENTORY_ACTIVATION_ENABLED === 'true') activation.push(style);
    }
    let draftsCreated = 0;
    if (missing.length) {
      const { contentSha256, ...subset } = snapshot; subset.styles = missing;
      const result = await createCatalogImporter({ client, mappingStore, mediaRoot, now }).importSnapshot({ ...subset, contentSha256: hash(JSON.stringify(subset)) }, { apply: true });
      draftsCreated = result.draftsCreated;
    }
    if (activation.length) await activateInventory({ mappingStore, client, locationId: env.SHOPIFY_LOCATION_ID, styles: activation, apply: true, now });
    let published = 0;
    const publicationEnabled = env.SHOPIFY_CATALOG_PUBLICATION_ENABLED === 'true' && env.SHOPIFY_SHARED_CAPACITY_ENABLED === 'true' && env.SHOPIFY_PAYMENT_OPERATIONS_ENABLED === 'true';
    if (publicationEnabled) {
      assert(/^gid:\/\/shopify\/Publication\/\d+$/.test(env.SHOPIFY_PUBLICATION_ID || '') && /^gid:\/\/shopify\/Location\/\d+$/.test(env.SHOPIFY_LOCATION_ID || ''), 'Reviewed publication and inventory location are required');
      for (const style of snapshot.styles) {
        const mapped = await mappingStore.getProduct(style.sourceUuid);
        if (!mapped || mapped.structureSha256 !== structuralHash(style)) throw new Error('Published source structure changed; merchant review required');
        const ready = readinessProvider ? await readinessProvider(style, mapped) : await capacityReady(runtime, style, mapped, { locationId: env.SHOPIFY_LOCATION_ID });
        if (!ready) continue;
        await mappingStore.withLock(`product:${style.sourceUuid}`, async () => {
          const input = { id: mapped.productGid, publication: env.SHOPIFY_PUBLICATION_ID };
          const read = async () => {
            const product = (await client.request(readPublication, input)).product;
            assert(product?.id === mapped.productGid && product.metafield?.value === style.sourceUuid && ['DRAFT', 'ACTIVE'].includes(product.status), 'Shopify publication ownership or status differs');
            return product;
          };
          async function reconcileMutation(key, mutationInput, complete, mutate) {
            const current = await read(); const previous = await mappingStore.getOperation(key);
            if (complete(current)) {
              if (previous) await mappingStore.saveOperation(key, { ...previous, status: 'complete', reconciledAt: new Date(now()).toISOString() });
              return false;
            }
            assert(!previous || !['sent', 'unknown'].includes(previous.status), 'Shopify publication outcome is unresolved; readback has not confirmed it');
            assert(!previous || JSON.stringify(previous.input) === JSON.stringify(mutationInput), 'Frozen publication input differs');
            const intent = { input: mutationInput, status: 'sent', sentAt: previous?.sentAt || new Date(now()).toISOString() };
            await mappingStore.saveOperation(key, intent);
            try {
              await mutate();
              assert(complete(await read()), 'Shopify publication readback differs');
              await mappingStore.saveOperation(key, { ...intent, status: 'complete', completedAt: new Date(now()).toISOString() });
              return true;
            } catch (error) {
              await mappingStore.saveOperation(key, { ...intent, status: error instanceof UnknownMutationOutcomeError ? 'unknown' : 'failed', errorCode: error.code || 'SHOPIFY_PUBLICATION_REVIEW' });
              throw error;
            }
          }
          await reconcileMutation(`product-active:${mapped.productGid}`, { id: mapped.productGid, status: 'ACTIVE' }, (product) => product.status === 'ACTIVE', async () => {
            const result = await client.request(activateProduct, { product: { id: mapped.productGid, status: 'ACTIVE' } }, { kind: 'mutation' });
            userErrors(result.productUpdate, 'product activation');
          });
          if (await reconcileMutation(`product-publish:${mapped.productGid}:${input.publication}`, input, (product) => product.publishedOnPublication === true, async () => {
            const result = await client.request(publishProduct, { id: mapped.productGid, input: [{ publicationId: input.publication }] }, { kind: 'mutation' });
            userErrors(result.publishablePublish, 'product publication');
          })) published++;
        });
      }
    }
    return { status: 'complete', styles: snapshot.styles.length, draftsCreated, published, publicationPaused: !publicationEnabled };
  };
}
