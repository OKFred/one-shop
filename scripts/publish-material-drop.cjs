#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const ROOT = process.cwd();
const PRIVATE_DATA = path.resolve(process.env.PRIVATE_DATA_DIR || path.join(ROOT, 'data'));
const LIBRARY = path.resolve(process.env.MATERIAL_LIBRARY_DIR || path.join(PRIVATE_DATA, 'material-library'));
const MEDIA = path.resolve(process.env.MATERIAL_MEDIA_DIR || path.join(ROOT, 'media/source-library'));
function mediaFile(localPath) {
  assert(/^media\/source-library\/[a-f0-9]{64}\.(?:webp|jpe?g|png)$/i.test(localPath), 'Invalid material image path');
  return path.join(MEDIA, path.basename(localPath));
}
const PREFIX = 'SHUSHA-';
const LOCKS = ['shusha-material-publication-v1', 'shusha-source-price-sync-v1'];
const ATTRIBUTES = [{ code: 'shusha_color', name: 'Color' }, { code: 'shusha_size', name: 'Size' }];
const CATEGORIES = { dresses: 'dresses', tops: 'tops', pants: 'pants' };
const PUBLICATION = 'shusha_material_publication';
const SLOTS = 'shusha_material_slot';

function assert(condition, message) { if (!condition) throw new Error(message); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function usd(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e8 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, `${label} must be an exact positive source USD price`);
  return value;
}
function text(value, label, max = 100) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f<>]/.test(value), `Invalid ${label}`);
  return value.trim();
}
function validateSlot(slot) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(slot || ''), '--slot must be an explicit YYYY-MM-DD Asia/Shanghai date');
  const date = new Date(`${slot}T12:00:00Z`);
  assert(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === slot && [2, 5].includes(date.getUTCDay()), '--slot must be a valid Tuesday or Friday date');
  return slot;
}
function parseArguments(args) {
  const options = { limit: 2, maxAgeHours: 48 };
  const operations = args.filter((arg) => ['--prepare-existing', '--publish-next'].includes(arg));
  const actions = args.filter((arg) => ['--dry-run', '--apply', '--verify'].includes(arg));
  assert(operations.length === 1 && actions.length === 1, 'Choose --prepare-existing or --publish-next and exactly one of --dry-run, --apply, --verify');
  options.operation = operations[0].slice(2); options.action = actions[0].slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ([...operations, ...actions].includes(arg)) continue;
    assert(['--limit', '--slot', '--max-age-hours'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--'), `Unknown or incomplete argument ${arg}`);
    const value = args[++i];
    if (arg === '--slot') options.slot = value;
    else if (arg === '--limit') options.limit = Number(value);
    else options.maxAgeHours = Number(value);
  }
  assert(Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= 4, '--limit must be from 1 to 4 (default 2)');
  assert(Number.isInteger(options.maxAgeHours) && options.maxAgeHours >= 1 && options.maxAgeHours <= 168, '--max-age-hours must be 1 to 168');
  if (options.operation === 'publish-next') validateSlot(options.slot);
  else assert(options.slot === undefined && options.limit === 2, '--slot/--limit are only for --publish-next');
  return options;
}
function assertPublicationBatch(selected, options) {
  if (options.operation === 'publish-next' && !selected.slot) {
    assert(selected.plans.length === options.limit, `Not enough reviewed READY material styles for new slot ${options.slot}: required ${options.limit}, eligible ${selected.plans.length}. Review at least ${Math.max(0, options.limit - selected.plans.length)} more styles before applying. No slot or product is created.`);
  }
  assert(selected.plans.length > 0, `No READY material styles; no publication performed: ${JSON.stringify(selected.excluded)}`);
}
function categoryFor(source) {
  const matches = [];
  const title = text(source.title, 'source title', 300);
  if (/\bdress(?:es)?\b/i.test(title)) matches.push('dresses');
  if (/\b(?:top|tops|blouse|blouses)\b/i.test(title)) matches.push('tops');
  if (/\b(?:pant|pants|trouser|trousers)\b/i.test(title)) matches.push('pants');
  assert(matches.length === 1, `Unknown or conflicting source category for ${source.sourceId}: ${title}`);
  if (source.publication?.category) assert(source.publication.category === matches[0], `Reviewed category conflicts with source title for ${source.sourceId}`);
  return matches[0];
}
function localAsset(asset) {
  assert(asset && typeof asset.localPath === 'string' && /^media\/source-library\/[a-f0-9]{64}\.(?:webp|jpg|jpeg|png)$/i.test(asset.localPath), 'Source image must be a content-addressed local material-library file');
  assert(/^[a-f0-9]{64}$/i.test(asset.sha256 || '') && path.basename(asset.localPath).split('.')[0].toLowerCase() === asset.sha256.toLowerCase(), 'Material image filename/hash differ');
  assert(Number.isInteger(asset.bytes) && asset.bytes > 0 && Number.isInteger(asset.width) && Number.isInteger(asset.height) && asset.width > 0 && asset.height > 0, 'Material image byte/dimension evidence is missing');
  const filename = mediaFile(asset.localPath);
  assert(filename.startsWith(MEDIA + path.sep), 'Material image escaped the managed directory');
  return { sourceUrl: asset.sourceUrl, localPath: asset.localPath, assetUrl: `/assets/${asset.localPath.slice('media/'.length)}`, sha256: asset.sha256.toLowerCase(), bytes: asset.bytes };
}
function normalizedStyle(source, category, media, options, existing) {
  assert(/^L\d{3,8}$/.test(source.sourceId || ''), 'Invalid actual source style ID');
  const title = text(source.title, 'source title', 300);
  assert(source.sourceCurrency === 'LKR' && source.displayCurrency === 'USD', `Unresolved currency for ${source.sourceId}`);
  assert(source.sourceCategoryNames?.includes(source.sourceId), `Source category/style ID ownership is unresolved for ${source.sourceId}`);
  assert(source.sourceCategoryName === source.sourceId, `Conflicting source alias/category for ${source.sourceId}`);
  assert(source.sourceUrl === 'https://wh.suusha.com/', `Unexpected source URL for ${source.sourceId}`);
  const age = Date.now() - Date.parse(source.capturedAt);
  assert(Number.isFinite(age) && age >= -60000 && age <= options.maxAgeHours * 3600000, `Source snapshot is stale for ${source.sourceId}`);
  usd(source.sourcePriceUsd, `${source.sourceId} style price`);
  if (!existing) {
    assert(source.publication?.ready === true && Number.isFinite(Date.parse(source.publication.reviewedAt)) && typeof source.publication.reviewNote === 'string' && source.publication.reviewNote.trim().length > 0, `${source.sourceId} is not publication READY/reviewed`);
    const { productReviewFingerprint } = require('./suusha-source.cjs');
    assert(source.publication.reviewedSourceSha256 === productReviewFingerprint(source), `${source.sourceId} visual review no longer matches its source SKU/colour/size/gallery facts`);
  }
  assert(Array.isArray(source.variants) && source.variants.length > 0, `No actual source variants for ${source.sourceId}`);
  const variants = []; const unavailable = []; const sourceSkus = new Set(); const combinations = new Set();
  for (const variant of source.variants) {
    if (variant.available !== true || !(variant.availableQty > 0)) {
      unavailable.push({ sourceVariantSku: variant.sourceSku, color: variant.color, size: variant.size, sourceAvailable: variant.available === true, sourceAvailableQty: variant.availableQty });
      continue;
    }
    assert(variant.resolved === true && /^[A-Za-z0-9._-]{1,80}$/.test(variant.sourceSku || ''), `Source SKU unresolved/unsafe for ${source.sourceId}`);
    const color = text(variant.color, 'source color'); const size = text(variant.size, 'source size');
    assert(source.colors.some((row) => row.id === variant.colorId && row.name === variant.color) && source.sizes.some((row) => row.id === variant.sizeId && row.name === variant.size), `Source color/size ID mapping differs for ${variant.sourceSku}`);
    const key = JSON.stringify([color, size]);
    assert(!sourceSkus.has(variant.sourceSku) && !combinations.has(key), `Duplicate source SKU or color/size for ${source.sourceId}`);
    sourceSkus.add(variant.sourceSku); combinations.add(key);
    const sourcePriceUsd = usd(variant.prices?.resale?.usd, `${variant.sourceSku} resale price`);
    assert(Array.isArray(variant.gallery) && variant.gallery.length > 0 && variant.gallery.length <= 24, `Missing complete source gallery for ${variant.sourceSku}`);
    const images = [...new Set(variant.gallery)].map((url) => {
      const parsed = new URL(url);
      assert(parsed.protocol === 'https:' && ['cdn.suusha.com', 'wh.suusha.com'].includes(parsed.hostname) && !parsed.username && !parsed.password, `Unapproved image host for available variant ${variant.sourceSku}`);
      const asset = media.get(url); assert(asset, `Image not downloaded/indexed for ${variant.sourceSku}: ${url}`);
      return localAsset(asset);
    });
    const uniqueImages = [...new Map(images.map((image) => [image.assetUrl, image])).values()];
    variants.push({ sourceVariantSku: variant.sourceSku, color, size, sourcePriceUsd, sourceAvailableQty: variant.availableQty, images: uniqueImages });
  }
  assert(variants.length > 0 && variants.length <= 100, `No usable available variants (or too many) for ${source.sourceId}`);
  const sourceId = source.sourceId;
  variants.forEach((variant, index) => {
    variant.storeSku = index === 0 ? `${PREFIX}${sourceId}` : `${PREFIX}${sourceId}-V-${variant.sourceVariantSku}`;
    variant.storeUrlKey = index === 0 ? `${sourceId.toLowerCase()}` : `${sourceId.toLowerCase()}-v-${variant.sourceVariantSku.toLowerCase().replace(/[._]/g, '-')}`;
    variant.anchor = index === 0;
  });
  assert(new Set(variants.map((row) => row.storeUrlKey)).size === variants.length, `Case-folding URL collision for ${sourceId}`);
  return { sourceId, title, category, capturedAt: source.capturedAt, sourcePriceUsd: source.sourcePriceUsd, variants, unavailable, existing, review: source.publication || null };
}
async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function atomicJson(filename, value, mode = 0o600) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const file = await fs.open(temporary, 'wx', mode);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await fs.rename(temporary, filename);
}
function mapPath(base, backupDir) {
  const sourceMap = path.resolve(base, 'store-map.json');
  const filename = path.resolve(process.env.MATERIAL_PUBLICATION_MAP_PATH || sourceMap);
  assert(filename === sourceMap || filename.startsWith(path.resolve(backupDir) + path.sep), 'Alternate material map must be inside the private publication backup directory');
  return filename;
}
async function inputs() {
  const base = LIBRARY;
  const bytes = await fs.readFile(path.join(base, 'catalog.json'));
  const catalog = JSON.parse(bytes); const integrity = await readJson(path.join(base, 'catalog.sha256.json'));
  assert(catalog.schemaVersion === 1 && Array.isArray(catalog.products) && integrity.sha256 === sha(bytes), 'Material catalog schema/hash differs');
  const images = await readJson(path.join(base, 'media-index.json'));
  assert(images.schemaVersion === 1 && Array.isArray(images.assets), 'Invalid material media index');
  const media = new Map(images.assets.map((asset) => [asset.sourceUrl, asset]));
  assert(media.size === images.assets.length, 'Duplicate source URLs in media index');
  const showcase = await readJson(path.join(PRIVATE_DATA, 'showcase.json'), { schemaVersion: 1, products: [] });
  assert(showcase.schemaVersion === 1 && Array.isArray(showcase.products), 'Existing showcase anchor manifest differs');
  return { catalog, media, showcase, sha256: sha(bytes), base };
}
async function verifyAssets(plans) {
  const checked = new Set();
  for (const asset of plans.flatMap((style) => style.variants.flatMap((variant) => variant.images))) {
    if (checked.has(asset.localPath)) continue;
    const filename = mediaFile(asset.localPath); const stat = await fs.lstat(filename);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.bytes, `Material file missing/type/size differs: ${asset.localPath}`);
    assert(sha(await fs.readFile(filename)) === asset.sha256, `Material file hash differs: ${asset.localPath}`);
    checked.add(asset.localPath);
  }
  return checked.size;
}
async function relationExists(client, name) { return Boolean((await client.query('SELECT to_regclass($1) AS name', [`public.${name}`])).rows[0].name); }
async function readLedger(client) {
  return await relationExists(client, PUBLICATION) ? (await client.query(`SELECT * FROM ${PUBLICATION} ORDER BY source_id`)).rows : [];
}
async function selectPlans(client, data, options) {
  const ledger = await readLedger(client);
  if (options.operation === 'publish-next' && await relationExists(client, SLOTS)) {
    const slot = (await client.query(`SELECT * FROM ${SLOTS} WHERE slot=$1`, [options.slot])).rows[0];
    if (slot) {
      assert(slot.style_limit === options.limit, 'This slot has a different frozen --limit; no additional styles will be published');
      return { plans: slot.plan, excluded: [], slot, resumed: true };
    }
    const unfinished = (await client.query(`SELECT slot,status FROM ${SLOTS} WHERE status<>'complete' ORDER BY slot LIMIT 1`)).rows[0];
    assert(!unfinished, `Earlier publication slot ${unfinished?.slot} is ${unfinished?.status}; inspect its journal and resume that original slot before reserving another`);
  }
  const existingSkus = new Set((await client.query('SELECT sku FROM product WHERE LEFT(sku,$1)=$2', [PREFIX.length, PREFIX])).rows.map((row) => row.sku));
  const sourceById = new Map(data.catalog.products.map((source) => [source.sourceId, source]));
  assert(sourceById.size === data.catalog.products.length, 'Duplicate source style IDs');
  const candidates = options.operation === 'prepare-existing'
    ? data.showcase.products.map((anchor) => ({ source: sourceById.get(anchor.sourceId), anchor }))
    : [...data.catalog.products].sort((a, b) => Number(b.sourceId.slice(1)) - Number(a.sourceId.slice(1))).map((source) => ({ source }));
  const plans = []; const excluded = [];
  for (const { source, anchor } of candidates) {
    const sourceId = anchor?.sourceId || source.sourceId;
    const recorded = ledger.find((row) => row.source_id === sourceId);
    if (options.operation === 'prepare-existing' && recorded) { plans.push(recorded.plan); continue; }
    if (options.operation === 'publish-next' && (recorded || existingSkus.has(`${PREFIX}${sourceId}`))) { excluded.push({ sourceId, reason: 'already-published-or-existing-anchor' }); continue; }
    try {
      assert(source, `Material capture missing for ${sourceId}`);
      if (anchor) assert(anchor.sku === `${PREFIX}${sourceId}` && anchor.url_key === `${sourceId.toLowerCase()}` && CATEGORIES[anchor.category], `Original anchor ownership differs for ${sourceId}`);
      const category = anchor ? anchor.category : categoryFor(source);
      const plan = normalizedStyle(source, category, data.media, options, Boolean(anchor));
      if (anchor) assert(existingSkus.has(anchor.sku), `Original anchor is missing for ${sourceId}`);
      plans.push(plan);
      if (options.operation === 'publish-next' && plans.length >= options.limit) break;
    } catch (error) { excluded.push({ sourceId, reason: error.message }); }
  }
  if (options.operation === 'prepare-existing') assert(data.showcase.products.length > 0 && plans.length === data.showcase.products.length, `Existing anchor preparation is incomplete: ${JSON.stringify(excluded)}`);
  return { plans, excluded, slot: null, resumed: false };
}
async function snapshot(client, selected, options, inputHash, mappingPath) {
  const rows = {};
  for (const table of ['product', 'product_description', 'product_inventory', 'product_image', 'product_attribute_value_index', 'product_collection', 'url_rewrite', 'variant_group', 'attribute', 'attribute_option', 'attribute_group_link']) {
    // Catalog-only backup: excludes customer/order/session data. Each table is from the fixed allowlist above.
    rows[table] = (await client.query(`SELECT * FROM ${table}`)).rows;
  }
  rows[PUBLICATION] = await readLedger(client);
  rows[SLOTS] = await relationExists(client, SLOTS) ? (await client.query(`SELECT * FROM ${SLOTS}`)).rows : [];
  const protectedInventory = (await client.query('SELECT p.product_id,p.sku,p.price,i.qty,i.manage_stock,i.stock_availability FROM product p JOIN product_inventory i ON i.product_inventory_product_id=p.product_id ORDER BY p.product_id')).rows;
  const protectedOtherProducts = rows.product.filter((row) => !row.sku.startsWith(PREFIX));
  const sourceMap = await readJson(path.join(LIBRARY, 'store-map.json'), { schemaVersion: 1, mappings: [] });
  const mapping = await readJson(mappingPath, null);
  return { schemaVersion: 1, createdAt: new Date().toISOString(), options, inputHash, plans: selected.plans, rows, protectedInventory, protectedOtherProducts, sourceMap, storeMap: mapping, storeMapPath: mappingPath };
}
async function createLedger(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${PUBLICATION} (source_id text PRIMARY KEY, anchor_sku text UNIQUE NOT NULL, status text NOT NULL CHECK(status IN ('preparing','complete')), mode text NOT NULL, slot text, group_id integer, plan jsonb NOT NULL, manifest_sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${SLOTS} (slot text PRIMARY KEY, style_limit integer NOT NULL CHECK(style_limit BETWEEN 1 AND 4), status text NOT NULL CHECK(status IN ('running','complete','failed')), plan jsonb NOT NULL, manifest_sha256 text NOT NULL, run_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
}
async function invokeNativeController(handler, request) {
  let status; let body;
  const response = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await handler(request, response, () => {});
  assert(status === 200 && body?.data && !body.error, `Native variant controller failed: ${body?.error?.message || status}`);
  return body.data;
}
async function liveProducts(client, skus) {
  return (await client.query('SELECT p.*,d.url_key,i.qty AS inventory_qty,i.manage_stock AS inventory_managed,i.stock_availability AS inventory_available FROM product p JOIN product_description d ON d.product_description_product_id=p.product_id JOIN product_inventory i ON i.product_inventory_product_id=p.product_id WHERE p.sku=ANY($1::text[]) ORDER BY p.product_id', [skus])).rows;
}
async function preflight(client, plans) {
  const categories = {};
  for (const [key, slug] of Object.entries(CATEGORIES)) {
    const rows = (await client.query('SELECT c.category_id,d.url_key FROM category c JOIN category_description d ON d.category_description_category_id=c.category_id WHERE d.url_key=$1', [slug])).rows;
    assert(rows.length === 1, `Managed category is missing/ambiguous: ${slug}`); categories[key] = rows[0].category_id;
  }
  const collection = (await client.query('SELECT collection_id FROM collection WHERE code=$1', ['shusha-edit-2026'])).rows;
  assert(collection.length === 1, 'Managed collection shusha-edit-2026 is missing/ambiguous');
  assert((await client.query('SELECT attribute_group_id FROM attribute_group WHERE attribute_group_id=1')).rows.length === 1, 'Native attribute group 1 is missing');
  for (const plan of plans) {
    const recorded = (await readLedger(client)).find((row) => row.source_id === plan.sourceId);
    const rows = await liveProducts(client, plan.variants.map((row) => row.storeSku));
    for (const variant of plan.variants) {
      const row = rows.find((product) => product.sku === variant.storeSku);
      if (row) {
        assert(row.url_key === variant.storeUrlKey && row.group_id === 1 && row.category_id === categories[plan.category], `SKU/category/path ownership conflict for ${variant.storeSku}`);
        assert(!row.variant_group_id || row.variant_group_id === recorded?.group_id, `Variant group ownership conflict for ${variant.storeSku}`);
        assert(plan.existing && variant.anchor || recorded, `Unjournaled existing product conflicts with ${variant.storeSku}`);
      } else if (plan.existing && variant.anchor) throw new Error(`Original anchor missing: ${variant.storeSku}`);
      const slugOwner = (await client.query('SELECT p.sku FROM product_description d JOIN product p ON p.product_id=d.product_description_product_id WHERE d.url_key=$1', [variant.storeUrlKey])).rows;
      assert(slugOwner.every((owner) => owner.sku === variant.storeSku), `URL key belongs to a different SKU: ${variant.storeUrlKey}`);
    }
  }
  const packageId = process.env.MATERIAL_PUBLICATION_PACKAGE_ID ? Number(process.env.MATERIAL_PUBLICATION_PACKAGE_ID) : null;
  if (plans.some(plan => !plan.existing)) {
    assert(Number.isSafeInteger(packageId) && packageId > 0 && (await client.query('SELECT package_id FROM package WHERE package_id=$1', [packageId])).rows.length === 1, 'New shippable styles require an explicit valid MATERIAL_PUBLICATION_PACKAGE_ID; packing dimensions remain subject to merchant confirmation');
  }
  return { categories, collectionId: collection[0].collection_id, packageId };
}
async function ensureAttributes(client, services, plans, step) {
  const attributeIds = {}; const optionIds = new Map();
  for (let index = 0; index < ATTRIBUTES.length; index++) {
    const definition = ATTRIBUTES[index];
    const labels = [...new Set(plans.flatMap((style) => style.variants.map((variant) => index === 0 ? variant.color : variant.size)))];
    let attribute = (await client.query('SELECT * FROM attribute WHERE attribute_code=$1', [definition.code])).rows[0];
    if (!attribute) {
      await step(`attribute:${definition.code}`, async () => {
        const row = await services.createAttribute({ attribute_code: definition.code, attribute_name: definition.name, type: 'select', is_required: 0, display_on_frontend: 0, is_filterable: 1, sort_order: index + 10, groups: [1], options: labels.map((label) => ({ option_text: label })) });
        return { id: row.attribute_id, uuid: row.uuid };
      });
      attribute = (await client.query('SELECT * FROM attribute WHERE attribute_code=$1', [definition.code])).rows[0];
    }
    assert(attribute.type === 'select' && attribute.attribute_name === definition.name, `Managed select attribute ownership differs: ${definition.code}`);
    assert((await client.query('SELECT 1 FROM attribute_group_link WHERE attribute_id=$1 AND group_id=1', [attribute.attribute_id])).rows.length === 1, `Managed attribute not assigned to native group 1: ${definition.code}`);
    attributeIds[definition.code] = attribute.attribute_id;
    for (const label of labels) {
      let options = (await client.query('SELECT * FROM attribute_option WHERE attribute_id=$1 AND option_text=$2', [attribute.attribute_id, label])).rows;
      assert(options.length <= 1, `Duplicate option text for ${definition.code}/${label}`);
      if (!options.length) {
        // Append only. Native updateAttribute replaces the entire option list and
        // could delete unrelated existing options; use its native insert path.
        await step(`option:${definition.code}:${label}`, async () => {
          const row = await services.qb.insert('attribute_option').given({ attribute_id: attribute.attribute_id, attribute_code: definition.code, option_text: label }).execute(services.pool);
          return { id: row.attribute_option_id };
        });
        options = (await client.query('SELECT * FROM attribute_option WHERE attribute_id=$1 AND option_text=$2', [attribute.attribute_id, label])).rows;
      }
      optionIds.set(`${definition.code}\u0000${label}`, options[0].attribute_option_id);
    }
  }
  return { attributeIds, optionIds };
}
async function applyStyle(client, services, plan, targets, attributes, step, manifestHash, options) {
  await client.query(`INSERT INTO ${PUBLICATION}(source_id,anchor_sku,status,mode,slot,plan,manifest_sha256) VALUES($1,$2,'preparing',$3,$4,$5,$6) ON CONFLICT(source_id) DO NOTHING`, [plan.sourceId, plan.variants[0].storeSku, options.operation, options.slot || null, JSON.stringify(plan), manifestHash]);
  let record = (await client.query(`SELECT * FROM ${PUBLICATION} WHERE source_id=$1`, [plan.sourceId])).rows[0];
  assert(isDeepStrictEqual(record.plan, plan), `Frozen publication plan changed for ${plan.sourceId}; inspect original journal`);
  if (record.status === 'complete') {
    await verifyStyle(client, plan, targets, record.group_id);
    return { sourceId: plan.sourceId, action: 'already-complete' };
  }
  let group;
  if (record.group_id) group = (await client.query('SELECT * FROM variant_group WHERE variant_group_id=$1', [record.group_id])).rows[0];
  else {
    group = await step(`group:${plan.sourceId}`, async () => {
      const created = await invokeNativeController(services.createGroup, { body: { attribute_codes: ATTRIBUTES.map((row) => row.code), attribute_group_id: 1, source_id: plan.sourceId } });
      await client.query(`UPDATE ${PUBLICATION} SET group_id=$1,updated_at=now() WHERE source_id=$2`, [created.variant_group_id, plan.sourceId]);
      return created;
    });
  }
  assert(group && group.attribute_group_id === 1 && new Set([group.attribute_one, group.attribute_two].filter(Boolean)).size === 2 && Object.values(attributes.attributeIds).every((id) => [group.attribute_one, group.attribute_two].includes(id)) && !group.attribute_three && !group.attribute_four && !group.attribute_five, `Managed variant group differs for ${plan.sourceId}`);
  let anchor = (await liveProducts(client, [plan.variants[0].storeSku]))[0];
  const qty = plan.existing ? anchor.inventory_qty : 999;
  assert(Number.isInteger(qty) && qty >= 0, `Original anchor inventory is invalid for ${plan.sourceId}`);
  const enabledStatus = plan.existing ? Boolean(anchor.status) : true;
  const items = [];
  for (const variant of plan.variants) {
    let row = (await liveProducts(client, [variant.storeSku]))[0];
    const data = { attributes: [
      { attribute_code: ATTRIBUTES[0].code, value: String(attributes.optionIds.get(`${ATTRIBUTES[0].code}\u0000${variant.color}`)) },
      { attribute_code: ATTRIBUTES[1].code, value: String(attributes.optionIds.get(`${ATTRIBUTES[1].code}\u0000${variant.size}`)) }
    ], images: variant.images.map((image) => image.assetUrl), visibility: variant.anchor && plan.existing ? 1 : 0 };
    if (!row) {
      row = await step(`product-create:${variant.storeSku}`, async () => services.createProduct({ ...data,
        name: plan.title, sku: variant.storeSku, url_key: variant.storeUrlKey, status: 0, price: variant.sourcePriceUsd,
        qty, manage_stock: 1, stock_availability: qty > 0 ? 1 : 0, group_id: 1, category_id: targets.categories[plan.category],
        tax_class: anchor?.tax_class ?? null,
        ...(anchor?.weight !== null && anchor?.weight !== undefined ? { weight: Number(anchor.weight) } : {}),
        meta_title: `${plan.title} | SHUSHA`, meta_description: `${plan.title}. Source-listed colour and size. Dispatch from Sri Lanka; availability confirmed before payment.`,
        description: services.descriptionRows(`<p>${escapeHtml(plan.title)}</p><p>Choose a source-listed colour and size. We confirm availability and delivery costs before payment. Dispatch from Sri Lanka.</p>`),
        package_id: anchor?.package_id || targets.packageId
      }));
      row = (await liveProducts(client, [variant.storeSku]))[0];
      if (variant.anchor) anchor = row;
    } else {
      // Include native product fields so updateProduct's shared-field path
      // has a returned product row. Never send price/qty/inventory fields here.
      await step(`product-attributes:${variant.storeSku}`, async () => {
        await services.updateProduct(row.uuid, { ...data, category_id: row.category_id, tax_class: row.tax_class });
        return { id: row.product_id, preservedPriceInventory: true };
      });
    }
    await step(`product-url:${variant.storeSku}`, async () => {
      await services.rewriteProduct({ product_id: row.product_id, uuid: row.uuid, category_id: row.category_id });
      return { id: row.product_id };
    });
    if (!variant.anchor) await step(`variant-link:${variant.storeSku}`, async () => {
      if (row.variant_group_id !== group.variant_group_id) await invokeNativeController(services.addItem, { params: { id: group.uuid }, body: { product_id: row.uuid } });
      return { id: row.product_id, groupId: group.variant_group_id };
    });
    items.push({ row, variant });
  }
  // Children become selectable first. The anchor only joins after its group is
  // fully prepared, retaining its existing URL and avoiding a half-built card.
  for (const item of items.filter((item) => !item.variant.anchor)) await step(`variant-enable:${item.variant.storeSku}`, async () => {
    await services.updateProduct(item.row.uuid, { status: enabledStatus ? 1 : 0, visibility: 0, category_id: item.row.category_id, tax_class: item.row.tax_class });
    return { id: item.row.product_id };
  });
  await step(`anchor-link:${plan.sourceId}`, async () => {
    const fresh = (await liveProducts(client, [anchor.sku]))[0];
    if (fresh.variant_group_id !== group.variant_group_id) await invokeNativeController(services.addItem, { params: { id: group.uuid }, body: { product_id: anchor.uuid } });
    if (!plan.existing) await services.updateProduct(anchor.uuid, { status: 1, visibility: 1, category_id: anchor.category_id, tax_class: anchor.tax_class });
    return { id: anchor.product_id, groupId: group.variant_group_id };
  });
  for (const { row } of items) await client.query('INSERT INTO product_collection(product_id,collection_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [row.product_id, targets.collectionId]);
  await verifyStyle(client, plan, targets, group.variant_group_id);
  await client.query(`UPDATE ${PUBLICATION} SET status='complete',updated_at=now() WHERE source_id=$1`, [plan.sourceId]);
  return { sourceId: plan.sourceId, action: 'completed', variants: items.length, groupId: group.variant_group_id, unavailableVariants: plan.unavailable.length };
}
async function verifyStyle(client, plan, targets, groupId) {
  const rows = await liveProducts(client, plan.variants.map((variant) => variant.storeSku));
  assert(rows.length === plan.variants.length, `Missing managed variants for ${plan.sourceId}`);
  const grouped = (await client.query('SELECT sku,visibility FROM product WHERE variant_group_id=$1', [groupId])).rows;
  assert(grouped.length === rows.length && grouped.every((row) => rows.some((item) => item.sku === row.sku)), `Unexpected variant group member for ${plan.sourceId}`);
  assert(grouped.filter((row) => row.visibility).length === 1 && grouped.some((row) => row.sku === plan.variants[0].storeSku && row.visibility), `Anchor visibility differs for ${plan.sourceId}`);
    for (const variant of plan.variants) {
    const row = rows.find((item) => item.sku === variant.storeSku);
    assert(row.variant_group_id === groupId && row.url_key === variant.storeUrlKey && row.category_id === targets.categories[plan.category], `Variant ownership differs for ${variant.storeSku}`);
    const values = (await client.query('SELECT a.attribute_code,v.option_text FROM product_attribute_value_index v JOIN attribute a ON a.attribute_id=v.attribute_id WHERE v.product_id=$1 AND a.attribute_code=ANY($2::text[])', [row.product_id, ATTRIBUTES.map((item) => item.code)])).rows;
    assert(values.length === 2 && values.some((value) => value.attribute_code === ATTRIBUTES[0].code && value.option_text === variant.color) && values.some((value) => value.attribute_code === ATTRIBUTES[1].code && value.option_text === variant.size), `Actual color/size mapping differs for ${variant.storeSku}`);
    const images = (await client.query('SELECT * FROM product_image WHERE product_image_product_id=$1', [row.product_id])).rows;
    assert(images.length === variant.images.length && images.filter((image) => image.is_main).length === 1 && variant.images.every((asset) => images.some((image) => image.origin_image === asset.assetUrl)), `Native image gallery differs for ${variant.storeSku}`);
    const urls = (await client.query('SELECT request_path,target_path FROM url_rewrite WHERE entity_uuid=$1 AND entity_type=$2', [row.uuid, 'product'])).rows;
    assert(urls.some((url) => url.request_path === `/${CATEGORIES[plan.category]}/${variant.storeUrlKey}` && url.target_path === `/product/${row.uuid}`), `Public variant URL differs for ${variant.storeSku}`);
    assert((await client.query('SELECT 1 FROM product_collection WHERE product_id=$1 AND collection_id=$2', [row.product_id, targets.collectionId])).rows.length === 1, `Managed collection link missing: ${variant.storeSku}`);
  }
  return { sourceId: plan.sourceId, variants: rows.length, groupId };
}
async function verifyProtected(client, before) {
  const rows = (await client.query('SELECT p.product_id,p.sku,p.price,i.qty,i.manage_stock,i.stock_availability FROM product p JOIN product_inventory i ON i.product_inventory_product_id=p.product_id WHERE p.product_id=ANY($1::int[]) ORDER BY p.product_id', [before.protectedInventory.map((row) => row.product_id)])).rows;
  assert(JSON.stringify(rows) === JSON.stringify(before.protectedInventory), 'Existing source prices/inventory changed during publication; inspect the snapshot and concurrent operations');
  const others = (await client.query('SELECT * FROM product WHERE product_id=ANY($1::int[]) ORDER BY product_id', [before.protectedOtherProducts.map((row) => row.product_id)])).rows;
  const expected = [...before.protectedOtherProducts].sort((a, b) => a.product_id - b.product_id);
  assert(JSON.stringify(others) === JSON.stringify(expected), 'Unrelated catalog products changed during publication');
}
async function exportMap(client, base, filename) {
  const sourceMap = await readJson(path.join(base, 'store-map.json'), { schemaVersion: 1, mappings: [] });
  const existing = await readJson(filename, sourceMap);
  assert(existing.schemaVersion === 1 && Array.isArray(existing.mappings), 'Existing explicit price-sync map is invalid');
  const mappings = new Map(existing.mappings.map((row) => [row.storeSku, row]));
  for (const publication of await readLedger(client)) if (publication.status === 'complete') {
    for (const variant of publication.plan.variants) mappings.set(variant.storeSku, { storeSku: variant.storeSku, storeUrlKey: variant.storeUrlKey, sourceId: publication.source_id, sourceVariantSku: variant.sourceVariantSku, priceBasis: 'site-resale-display' });
  }
  const map = { schemaVersion: 1, updatedAt: new Date().toISOString(), mappings: [...mappings.values()].sort((a, b) => a.storeSku.localeCompare(b.storeSku)) };
  await atomicJson(filename, map);
  return { path: filename, mappings: map.mappings.length };
}
function safeError(error) {
  let value = error.message;
  for (const name of ['DB_PASSWORD', 'DATABASE_URL', 'APIKEY', 'SUUSHA_PRICE_API_KEY']) if (process.env[name]) value = value.split(process.env[name]).join('[REDACTED]');
  return value;
}
async function executePublication(options) {
  const data = await inputs();
  require('dotenv').config(); process.env.ALLOW_CONFIG_MUTATIONS = 'true';
  const version = require('@evershop/evershop/package.json').version;
  assert(version === '2.2.1', `Publication requires EverShop 2.2.1, found ${version}`);
  const { createCatalogServices } = await import('./lib/material-catalog.mjs');
  const services = await createCatalogServices();
  const { pool } = services;
  pool.options.connectionTimeoutMillis = 10000;
  let client; const locks = []; let journal; let journalPath;
  try {
    client = await pool.connect();
    for (const name of LOCKS) {
      assert((await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [name])).rows[0].locked, 'Another catalog publication or source price sync is running; no records changed'); locks.push(name);
    }
    const selected = await selectPlans(client, data, options);
    const assetCount = await verifyAssets(selected.plans);
    const targets = await preflight(client, selected.plans);
    const backupDir = path.resolve(process.env.MATERIAL_PUBLICATION_BACKUP_DIR || path.join(PRIVATE_DATA, 'backups/material-publication'));
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    assert((await fs.lstat(backupDir)).isDirectory() && !(await fs.lstat(backupDir)).isSymbolicLink(), 'Private backup directory must be a real directory');
    if (process.platform !== 'win32') await fs.chmod(backupDir, 0o700);
    const mappingPath = mapPath(data.base, backupDir);
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    assert(!/candidate|test|staging/i.test(database) || process.env.MATERIAL_PUBLICATION_MAP_PATH, 'Candidate/test/staging databases require MATERIAL_PUBLICATION_MAP_PATH inside the private backup directory');
    const before = await snapshot(client, selected, options, data.sha256, mappingPath);
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
    const snapshotPath = path.join(backupDir, `${runId}.snapshot.json`); journalPath = path.join(backupDir, `${runId}.run.json`);
    await atomicJson(snapshotPath, before);
    journal = { schemaVersion: 1, runId, database, options, status: 'preflight', snapshotPath, storeMapPath: mappingPath, manifestSha256: data.sha256, excluded: selected.excluded, steps: [] };
    await atomicJson(journalPath, journal);
    const step = async (label, action) => {
      const entry = { label, status: 'started', at: new Date().toISOString() }; journal.steps.push(entry); await atomicJson(journalPath, journal);
      const result = await action(); Object.assign(entry, { status: 'complete', result }); await atomicJson(journalPath, journal); return result;
    };
    let result;
    if (options.action === 'dry-run') {
      result = { plannedStyles: selected.plans.map((style) => ({ sourceId: style.sourceId, category: style.category, variants: style.variants.length, unavailableVariants: style.unavailable.length, anchorSourceVariantSku: style.variants[0].sourceVariantSku })), slot: options.slot || null, resumed: selected.resumed, assetCount, storeMapPath: mappingPath, excluded: selected.excluded };
      if (options.operation === 'publish-next') result.batchReadiness = { requestedStyles: options.limit, eligibleStyles: selected.plans.length, additionalReviewedStylesRequired: selected.slot ? 0 : Math.max(0, options.limit - selected.plans.length), canApply: Boolean(selected.slot) || selected.plans.length === options.limit };
      journal.status = 'dry-run-complete';
    } else if (options.action === 'verify') {
      const ledger = await readLedger(client); const verified = [];
      assert(selected.plans.length > 0, 'There are no published plans to verify');
      for (const style of selected.plans) {
        const record = ledger.find((row) => row.source_id === style.sourceId);
        assert(record?.status === 'complete' && record.group_id, `Publication incomplete for ${style.sourceId}`);
        verified.push(await verifyStyle(client, record.plan, targets, record.group_id));
      }
      if (options.operation === 'publish-next') assert(selected.slot?.status === 'complete', 'Publication slot is not complete');
      result = { verified, assetCount, slot: options.slot || null }; journal.status = 'verified';
    } else {
      // Validate before even creating the ledger tables or reserving this slot.
      // A partial set must remain available for the next reviewed full batch.
      assertPublicationBatch(selected, options);
      await createLedger(client);
      if (options.operation === 'publish-next') await client.query(`INSERT INTO ${SLOTS}(slot,style_limit,status,plan,manifest_sha256,run_id) VALUES($1,$2,'running',$3,$4,$5) ON CONFLICT(slot) DO NOTHING`, [options.slot, options.limit, JSON.stringify(selected.plans), data.sha256, runId]);
      journal.status = 'applying'; await atomicJson(journalPath, journal);
      const attributes = await ensureAttributes(client, services, selected.plans, step); const styles = [];
      for (const style of selected.plans) styles.push(await applyStyle(client, services, style, targets, attributes, step, data.sha256, options));
      await verifyProtected(client, before);
      const sourceMap = await exportMap(client, data.base, mappingPath);
      if (options.operation === 'publish-next') await client.query(`UPDATE ${SLOTS} SET status='complete',run_id=$1,updated_at=now() WHERE slot=$2`, [runId, options.slot]);
      result = { styles, sourceMap, assetCount, slot: options.slot || null, resumed: selected.resumed, inventoryPolicy: 'merchant request capacity; actual availability confirmed before payment' }; journal.status = 'applied';
    }
    journal.result = result; journal.finishedAt = new Date().toISOString(); await atomicJson(journalPath, journal);
    console.log(JSON.stringify({ status: journal.status, ...result, snapshotPath, journalPath }, null, 2));
  } catch (error) {
    if (journal) { journal.status = 'failed'; journal.error = safeError(error); journal.finishedAt = new Date().toISOString(); await atomicJson(journalPath, journal); }
    if (client && options.operation === 'publish-next' && options.action === 'apply' && await relationExists(client, SLOTS)) await client.query(`UPDATE ${SLOTS} SET status='failed',updated_at=now() WHERE slot=$1 AND status<>'complete'`, [options.slot]);
    throw error;
  } finally {
    if (client) { for (const name of locks.reverse()) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); client.release(); }
    await pool.end();
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('publish-material-drop.cjs (--prepare-existing | --publish-next --slot YYYY-MM-DD [--limit 2]) (--dry-run | --apply | --verify) [--max-age-hours 48]\nRead local captured catalog/media only. Publisher requires READY review, hash-verified available source variants, USD source prices; capacity is not supplier stock.'); return;
  }
  const options = parseArguments(process.argv.slice(2));
  const library = LIBRARY;
  await fs.mkdir(library, { recursive: true });
  const directory = await fs.lstat(library);
  assert(directory.isDirectory() && !directory.isSymbolicLink(), 'Material library must be a real directory');
  const lockPath = path.join(library, '.adapter.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('Another source adapter or material publisher run is active; inspect the local lock before retrying');
    throw error;
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode: `publication:${options.operation}:${options.action}` }));
    await executePublication(options);
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

module.exports = { parseArguments, validateSlot, assertPublicationBatch, normalizedStyle, categoryFor, localAsset, mapPath, verifyAssets, selectPlans, invokeNativeController };
if (require.main === module) main().catch((error) => { console.error(`Material publication failed: ${safeError(error)}`); process.exitCode = 1; });
