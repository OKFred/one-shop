#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sanitizeHtml from 'sanitize-html';
import { buildContentPlan, createContentSync, sanitizeContentHtml, writeMerchantThemeConfig } from './sync-content.mjs';
import { readVerifiedImage, validateCatalogSnapshot } from '../../extensions/shopify-bridge/src/services/catalog.js';
import { loadPublishedCollectionSnapshot } from '../../extensions/shopify-bridge/src/services/worker.js';

// Explicit public-page selection is separate from the supplier/catalog data.
// No customer, order, receiving-account or unlisted CMS query is performed.
export const PUBLIC_PAGE_HANDLES = Object.freeze(['about', 'about-us', 'how-to-order', 'shipping', 'shipping-policy', 'returns', 'return-policy', 'contact', 'contact-us', 'faq']);
export const PREPARATION_READ = Object.freeze({
  shop: 'query ShushaPreparationShop { shop { myshopifyDomain } }',
  media: 'query ShushaPreparationMedia($id:ID!) { node(id:$id) { ... on MediaImage { id fileStatus status image { url } } } }'
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;
const categories = ['dresses', 'pants', 'tops'];
const tags = ['p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
const attributes = { a: ['href'], th: ['scope'], td: ['colspan', 'rowspan'] };
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export const preparationDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function onlyKeys(value, allowed, name) {
  requireValue(plain(value) && Object.keys(value).every(key => allowed.includes(key)), `${name} contains an unsupported field`);
}
function boundedText(value, name, maximum = 400) {
  requireValue(typeof value === 'string' && value.length <= maximum && !/[\p{Cc}\p{Cf}]/u.test(value), `Invalid ${name}`);
  return value.trim();
}
function safeLink(value) {
  requireValue(typeof value === 'string' && value.length <= 500 && !/[\\\p{Cc}\p{Cf}]/u.test(value) && !/%(?:5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value), 'Unsafe public content link');
  if (/^\/(?!\/)/.test(value)) requireValue(!value.includes('..') && !/^\/(?:admin|api|account|checkout|payment)(?:\/|\?|$)/i.test(value), 'Private account/payment links cannot enter public CMS');
  else if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    requireValue(!url.username && !url.password && !/(?:^|\.)wise\.com$/i.test(url.hostname) && !/(?:access|token|api_key|password)=/i.test(url.search), 'Private receiving or credential links cannot enter public CMS');
  } else requireValue(/^(?:mailto:|tel:)[^\s<>]+$/i.test(value), 'Unsupported public content link');
}

/** Preserve supported public text; refuse lossy/ambiguous editor blocks or HTML. */
export function normalizePublicContent(value = '') {
  if (value == null || value === '') return '';
  requireValue(typeof value === 'string' && Buffer.byteLength(value) <= 256 * 1024, 'Public content must be bounded text');
  let html = value;
  if (/^[\[{]/.test(value.trim())) {
    let rows;
    try { rows = JSON.parse(value); } catch { throw new Error('Public editor content is invalid'); }
    requireValue(Array.isArray(rows) && rows.length <= 50, 'Public editor must contain bounded rows');
    const blocks = [];
    for (const row of rows) {
      requireValue(plain(row) && Array.isArray(row.columns) && row.columns.length <= 4, 'Unsupported public editor row');
      for (const column of row.columns) {
        requireValue(plain(column) && plain(column.data) && Array.isArray(column.data.blocks), 'Unsupported public editor column');
        blocks.push(...column.data.blocks);
      }
    }
    requireValue(blocks.length <= 200, 'Public editor contains too many blocks');
    html = blocks.map(block => {
      requireValue(plain(block) && plain(block.data), 'Invalid public editor block');
      if (block.type === 'raw') { requireValue(typeof block.data.html === 'string', 'Invalid raw public block'); return block.data.html; }
      if (block.type === 'paragraph') { requireValue(typeof block.data.text === 'string', 'Invalid public paragraph'); return `<p>${block.data.text}</p>`; }
      if (block.type === 'header') {
        requireValue(typeof block.data.text === 'string' && [2, 3, 4].includes(block.data.level || 3), 'Unsupported public heading');
        return `<h${block.data.level || 3}>${block.data.text}</h${block.data.level || 3}>`;
      }
      requireValue(block.type === 'list' && ['ordered', 'unordered'].includes(block.data.style) && Array.isArray(block.data.items) && block.data.items.length <= 100 && block.data.items.every(item => typeof item === 'string'), 'Unsupported public list or editor block');
      const tag = block.data.style === 'ordered' ? 'ol' : 'ul';
      return `<${tag}>${block.data.items.map(item => `<li>${item}</li>`).join('')}</${tag}>`;
    }).join('\n');
  }
  requireValue(!/<!--|<!DOCTYPE|<\?|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/iu.test(html), 'Ambiguous public markup requires review');
  requireValue(!/\b(?:iban|swift|bic|routing\s+number|account\s+number|bank\s+details|beneficiary)\b|开户行|银行账户|收款账号|api[_ -]?key|access[_ -]?token/i.test(html), 'Receiving or credential content is excluded from public CMS');
  sanitizeHtml(html, { allowedTags: tags, allowedAttributes: attributes, onOpenTag(name, attrs) {
    requireValue(tags.includes(name) && Object.keys(attrs).every(key => (attributes[name] || []).includes(key)), 'Unsupported public HTML tag or attribute');
    if (name === 'a' && attrs.href) safeLink(attrs.href);
    if (name === 'th' && attrs.scope) requireValue(['row', 'col', 'rowgroup', 'colgroup'].includes(attrs.scope), 'Unsupported table scope');
    for (const key of ['colspan', 'rowspan']) if (attrs[key]) requireValue(/^[1-9]\d?$/.test(attrs[key]), 'Unsupported table span');
  } });
  // The shared synchronizer uses the same conservative final representation.
  return sanitizeContentHtml(html.replace(/<(\/?)(b|i)(\s*>)/gi, (_match, slash, tag, end) => `<${slash}${tag.toLowerCase() === 'b' ? 'strong' : 'em'}${end}`));
}

export function validatePreparationInput(input = { schemaVersion: 1, approvedPageHandles: [] }) {
  onlyKeys(input, ['schemaVersion', 'approvedPageHandles', 'hero', 'footer', 'support', 'legacyRedirects'], 'Preparation input');
  requireValue(input.schemaVersion === 1 && Array.isArray(input.approvedPageHandles) && input.approvedPageHandles.length <= PUBLIC_PAGE_HANDLES.length && new Set(input.approvedPageHandles).size === input.approvedPageHandles.length && input.approvedPageHandles.every(handle => PUBLIC_PAGE_HANDLES.includes(handle)), 'Explicit public CMS allowlist is invalid');
  const hero = input.hero || {}; const footer = input.footer || {}; const support = input.support || {};
  onlyKeys(hero, ['eyebrow', 'heading', 'descriptionHtml', 'imageSource', 'primaryLabel', 'primaryLink', 'secondaryLabel', 'secondaryLink', 'noteLeft', 'noteRight'], 'Hero');
  onlyKeys(footer, ['descriptionHtml'], 'Footer'); onlyKeys(support, ['whatsappSriLanka', 'whatsappChina'], 'Support');
  const merchant = { hero: {}, footer: {}, support: {} };
  for (const [key, value] of Object.entries(hero)) {
    if (key === 'imageSource') continue;
    if (key === 'descriptionHtml') merchant.hero[key] = normalizePublicContent(value);
    else if (['primaryLink', 'secondaryLink'].includes(key)) {
      requireValue(typeof value === 'string' && (!value || /^\/(?!\/)[a-z0-9/_-]*$/i.test(value) && !value.includes('..')), 'Hero uses native internal routes only');
      if (value) merchant.hero[key] = value;
    } else merchant.hero[key] = boundedText(value, `hero ${key}`);
  }
  if (footer.descriptionHtml != null) merchant.footer.descriptionHtml = normalizePublicContent(footer.descriptionHtml);
  for (const [key, value] of Object.entries(support)) {
    requireValue(typeof value === 'string' && (!value || /^https:\/\/wa\.me\/\d{7,15}$/.test(value)), 'Support must contain reviewed public WhatsApp links'); merchant.support[key] = value;
  }
  if (hero.imageSource != null) {
    onlyKeys(hero.imageSource, ['sourceUuid', 'sha256'], 'Hero original-image selection');
    requireValue(uuid.test(hero.imageSource.sourceUuid || '') && sha.test(hero.imageSource.sha256 || ''), 'Hero must select one reviewed native style and original SHA256');
  }
  const redirects = input.legacyRedirects || [];
  requireValue(Array.isArray(redirects) && redirects.length <= 500 && redirects.every(row => plain(row) && Object.keys(row).every(key => ['path', 'target'].includes(key))), 'Legacy redirects must be bounded explicit public routes');
  return { merchant, approvedPageHandles: [...input.approvedPageHandles].sort(), heroSelection: hero.imageSource || null, redirects };
}

async function loadPublicPages(pool, handles) {
  if (!handles.length) return [];
  const rows = (await pool.query(`SELECT p.uuid,d.url_key,d.name,d.content FROM cms_page p
    JOIN cms_page_description d ON d.cms_page_description_cms_page_id=p.cms_page_id
    WHERE p.status=TRUE AND d.url_key=ANY($1::text[]) ORDER BY d.url_key LIMIT 11`, [handles])).rows;
  requireValue(rows.length === handles.length && new Set(rows.map(row => row.url_key)).size === rows.length && rows.every(row => handles.includes(row.url_key) && uuid.test(row.uuid)), 'Every selected public page must be active and uniquely identified');
  return rows.map(row => ({ sourceUuid: row.uuid, handle: row.url_key, title: boundedText(row.name, 'public page title', 200), bodyHtml: normalizePublicContent(row.content) }));
}

export async function verifyHeroOriginal({ runtime, selection, catalog, mediaRoot }) {
  if (!selection) return null;
  validateCatalogSnapshot(catalog);
  const style = catalog.styles.find(row => row.sourceUuid === selection.sourceUuid);
  const image = style?.images.find(row => row.sha256 === selection.sha256);
  requireValue(style && image && catalog.styles.filter(row => row.sourceUuid === selection.sourceUuid).length === 1, 'Hero image must belong to the private verified catalog');
  const rows = (await runtime.pool.query(`SELECT p.uuid,publication.plan FROM shusha_material_publication publication
    JOIN product p ON p.sku=publication.anchor_sku
    WHERE publication.status='complete' AND p.status=TRUE AND p.visibility=TRUE AND p.uuid=$1 LIMIT 2`, [selection.sourceUuid])).rows;
  const review = rows[0]?.plan?.review;
  requireValue(rows.length === 1 && rows[0].uuid === style.sourceUuid && rows[0].plan.sourceId === style.sourceId && rows[0].plan.category === style.category && review?.ready === true && Number.isFinite(Date.parse(review.reviewedAt)) && sha.test(review.reviewedSourceSha256 || ''), 'Current hero material lacks an unambiguous reviewed READY publication');
  const originals = rows[0].plan.variants?.flatMap(variant => variant.images || []);
  requireValue(Array.isArray(originals) && originals.some(asset => asset.sha256 === image.sha256 && asset.localPath === image.localPath && asset.bytes === image.bytes), 'Current reviewed original differs from the private catalog');
  const original = await readVerifiedImage(image, mediaRoot);
  const mapped = await runtime.repositories.mappings.getMedia(image.sha256);
  requireValue(mapped?.sha256 === image.sha256 && mapped.filename === original.filename && /^gid:\/\/shopify\/MediaImage\/\d+$/.test(mapped.gid || ''), 'Hero requires the exact existing uploaded original-image mapping');
  const file = (await runtime.client.request(PREPARATION_READ.media, { id: mapped.gid })).node;
  requireValue(file?.id === mapped.gid && file.fileStatus === 'READY' && file.status === 'READY' && typeof file.image?.url === 'string', 'Uploaded hero original is not READY');
  const url = new URL(file.image.url);
  requireValue(url.protocol === 'https:' && url.hostname === 'cdn.shopify.com' && !url.username && !url.password && decodeURIComponent(url.pathname.split('/').at(-1)) === original.filename, 'Uploaded hero filename or Shopify CDN ownership differs');
  return { sourceUuid: style.sourceUuid, sha256: image.sha256, localPath: image.localPath, bytes: image.bytes,
    filename: original.filename, mediaGid: mapped.gid, image: `shopify://shop_images/${original.filename}`,
    reviewedAt: review.reviewedAt, reviewedSourceSha256: review.reviewedSourceSha256 };
}

export async function buildStorePreparation({ runtime, env = process.env, input, catalog = null, mediaRoot,
  snapshotProvider = loadPublishedCollectionSnapshot, now = () => new Date() }) {
  requireValue(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(runtime.config.shop || ''), 'A configured Shopify shop is required');
  requireValue((await runtime.client.request(PREPARATION_READ.shop, {})).shop?.myshopifyDomain === runtime.config.shop, 'Shopify store identity differs');
  const normalized = validatePreparationInput(input);
  const source = await snapshotProvider(runtime, env);
  requireValue(Array.isArray(source.collections) && source.collections.length === 3 && new Set(source.collections.map(row => row.handle)).size === 3 && source.collections.every(row => categories.includes(row.handle) && uuid.test(row.sourceUuid)), 'Current native category UUIDs must be preserved');
  requireValue(!source.pages?.length && !source.menus?.length && !source.redirects?.length && Array.isArray(source.products) && source.products.length <= 500, 'Published snapshot exceeded its native catalog boundary');
  // The follower normalizes descriptions for routine collection maintenance.
  // Preparation additionally checks raw native markup before any lossy cleaning.
  const rawCategories = (await runtime.pool.query(`SELECT c.uuid,d.url_key,d.description FROM category c
    JOIN category_description d ON d.category_description_category_id=c.category_id
    WHERE c.status=TRUE AND d.url_key=ANY($1::text[]) ORDER BY d.url_key LIMIT 4`, [categories])).rows;
  requireValue(rawCategories.length === 3 && new Set(rawCategories.map(row => row.url_key)).size === 3, 'Raw native category selection is ambiguous');
  const collections = source.collections.map(row => {
    const raw = rawCategories.find(category => category.url_key === row.handle);
    requireValue(raw?.uuid === row.sourceUuid, 'Native category changed during preparation');
    return { ...row, descriptionHtml: normalizePublicContent(raw.description) };
  });
  const products = source.products.map(product => {
    requireValue(product.status === 'PUBLISHED' && uuid.test(product.sourceUuid), 'Only actual native published styles enter the content plan');
    const membership = collections.filter(collection => collection.productUuids.includes(product.sourceUuid));
    requireValue(membership.length === 1, 'Published style must have one canonical native category');
    return { ...product, categoryHandle: membership[0].handle };
  });
  const pages = await loadPublicPages(runtime.pool, normalized.approvedPageHandles);
  const menus = [
    { handle: 'shusha-main', title: 'SHUSHA main', items: categories.map(handle => ({ title: collections.find(row => row.handle === handle).title, type: 'collection', handle })) },
    { handle: 'shusha-footer', title: 'SHUSHA footer', items: pages.map(page => ({ title: page.title, type: 'page', handle: page.handle })) }
  ];
  const snapshot = { products, collections, pages, menus, redirects: normalized.redirects };
  const heroProof = await verifyHeroOriginal({ runtime, selection: normalized.heroSelection, catalog, mediaRoot });
  if (heroProof) normalized.merchant.hero.image = heroProof.image;
  const plan = buildContentPlan(snapshot, { publishPages: false });
  const proof = { snapshot, merchant: normalized.merchant, heroProof };
  const body = { schemaVersion: 1, shop: runtime.config.shop, capturedAt: now().toISOString(),
    input, snapshot, merchant: normalized.merchant, heroProof, plan, sourceSha256: preparationDigest(proof),
    unpublishedOnly: true, customerRecords: 0, historicalOrders: 0 };
  return { ...body, preparedSha256: preparationDigest(body) };
}

export function validatePreparedStore(prepared, reviewedSha256) {
  onlyKeys(prepared, ['schemaVersion', 'shop', 'capturedAt', 'input', 'snapshot', 'merchant', 'heroProof', 'plan', 'sourceSha256', 'unpublishedOnly', 'customerRecords', 'historicalOrders', 'preparedSha256'], 'Prepared store');
  const { preparedSha256, ...body } = prepared;
  requireValue(prepared.schemaVersion === 1 && prepared.unpublishedOnly === true && prepared.customerRecords === 0 && prepared.historicalOrders === 0 && sha.test(preparedSha256 || '') && preparationDigest(body) === preparedSha256 && (!reviewedSha256 || reviewedSha256 === preparedSha256), 'Saved prepared plan hash differs from the explicit review');
  requireValue(preparationDigest({ snapshot: prepared.snapshot, merchant: prepared.merchant, heroProof: prepared.heroProof }) === prepared.sourceSha256 && preparationDigest(buildContentPlan(prepared.snapshot, { publishPages: false })) === preparationDigest(prepared.plan), 'Prepared public content proof differs');
  validatePreparationInput(prepared.input);
  return prepared;
}

export async function applyPreparedStore({ runtime, env = process.env, prepared, reviewedSha256, reload,
  synchronizerFactory = createContentSync, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  requireValue(env.SHOPIFY_BRIDGE_ENABLED === 'true' && env.SHOPIFY_BRIDGE_WRITES_ENABLED === 'true' && env.SHOPIFY_CONTENT_SYNC_ENABLED === 'true' && runtime.config.enabled === true && runtime.config.writesEnabled === true, 'Content writes require explicit runtime enablement');
  requireValue(sha.test(reviewedSha256 || '') && typeof reload === 'function', 'Apply requires a saved prepared plan and explicit reviewed SHA256');
  validatePreparedStore(prepared, reviewedSha256);
  requireValue(prepared.shop === runtime.config.shop, 'Prepared shop identity differs');
  const store = runtime.repositories.mappings;
  return store.withLock(`content-sync:${runtime.config.shop}`, async () => {
    const current = validatePreparedStore(await reload());
    requireValue(current.shop === prepared.shop && current.sourceSha256 === prepared.sourceSha256 && preparationDigest(current.input) === preparationDigest(prepared.input), 'Current public source or original-image proof changed; prepare and review again');
    const key = `store-preparation:${prepared.preparedSha256}`;
    const previous = await store.getOperation(key);
    requireValue(!previous || previous.sourceSha256 === prepared.sourceSha256, 'Prepared content journal identity differs');
    await store.saveOperation(key, { sourceSha256: prepared.sourceSha256, status: 'pending', startedAt: previous?.startedAt || new Date().toISOString() });
    const sync = synchronizerFactory({ graphql: (document, variables) => runtime.client.request(document, variables),
      stateStore: { get: store.get, put: store.put, withLock: async work => work() },
      waitForJob: async (id, read) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          if ((await read(id)).job?.done === true) return true;
          if (attempt < 2) await sleep(150);
        }
        return false;
      }
    });
    try {
      const report = await sync.sync(prepared.snapshot, { dryRun: false, publishPages: false });
      await store.saveOperation(key, { sourceSha256: prepared.sourceSha256, status: 'complete', completedAt: new Date().toISOString() });
      return { status: 'unpublished-content-synchronized', preparedSha256: prepared.preparedSha256, ...report, themeWrites: false, publishWrites: false };
    } catch (error) {
      await store.saveOperation(key, { sourceSha256: prepared.sourceSha256, status: 'pending', lastError: 'content-needs-current-readback' }); throw error;
    }
  });
}

async function privateLocation(privateRoot, filename, { createParent = false } = {}) {
  const root = path.resolve(privateRoot); const directory = path.join(root, 'shopify'); const resolved = path.resolve(filename);
  requireValue(resolved.startsWith(directory + path.sep), 'Store preparation files must remain under private Shopify data');
  if (createParent) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root); requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Private data root must be an actual directory');
  let ancestor = root;
  for (const part of path.relative(root, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    if (createParent) await fs.mkdir(ancestor, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(ancestor); requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Private preparation path cannot traverse symlinks');
  }
  return resolved;
}
async function readPrivateJson(root, filename) {
  const resolved = await privateLocation(root, filename); const stat = await fs.lstat(resolved);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024 && resolved.endsWith('.private.json'), 'Preparation reads only bounded private JSON files');
  return JSON.parse(await fs.readFile(resolved, 'utf8'));
}
async function writePrivatePlan(root, filename, value) {
  const resolved = await privateLocation(root, filename, { createParent: true });
  requireValue(resolved.endsWith('.private.json'), 'Prepared content must use a private JSON file');
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let file;
  try { file = await fs.open(resolved, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST' || canonical(await readPrivateJson(root, resolved)) !== canonical(value)) throw error; return resolved; }
  try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
  return resolved;
}

/** CLI entry: read-only Shopify queries and private files by default. */
export async function prepareStore({ env = process.env, runtime = null, input = null, plan = null, reviewedSha256 = null,
  apply = false, theme = false, catalogPath = null, snapshotProvider = loadPublishedCollectionSnapshot, now = () => new Date() } = {}) {
  requireValue(!apply || plan && reviewedSha256, '--apply requires --plan and --reviewed-sha256');
  requireValue(!apply || !theme, 'Theme generation and content apply are separate operations');
  requireValue(!apply || !input, 'Apply reads the frozen saved plan input only');
  requireValue(apply || !reviewedSha256, 'Reviewed plan hash is used only with --apply');
  const root = path.resolve(env.PRIVATE_DATA_DIR || path.join(process.cwd(), 'data'));
  const ownsRuntime = !runtime;
  if (!runtime) { const { bridgeRuntime } = await import('../../extensions/shopify-bridge/src/services/runtime.js'); runtime = bridgeRuntime(); }
  try {
    const saved = apply ? validatePreparedStore(await readPrivateJson(root, plan), reviewedSha256) : null;
    const merchant = saved?.input || (input ? await readPrivateJson(root, input) : { schemaVersion: 1, approvedPageHandles: [] });
    const load = async () => {
      const selection = validatePreparationInput(merchant).heroSelection;
      const catalog = selection ? await readPrivateJson(root, catalogPath || path.join(root, 'shopify', 'catalog.private.json')) : null;
      return buildStorePreparation({ runtime, env, input: merchant, catalog,
        mediaRoot: path.resolve(env.MATERIAL_MEDIA_DIR || path.join(process.cwd(), 'media/source-library')), snapshotProvider, now });
    };
    if (apply) return applyPreparedStore({ runtime, env, prepared: saved, reviewedSha256, reload: load });
    const prepared = await runtime.repositories.mappings.withLock(`content-sync:${runtime.config.shop}`, load);
    const filename = await writePrivatePlan(root, plan || path.join(root, 'shopify', 'prepared', `${prepared.preparedSha256}.private.json`), prepared);
    let themePath = null;
    if (theme) {
      themePath = await privateLocation(root, path.join(root, 'shopify', 'private', `theme-${prepared.preparedSha256}`), { createParent: true });
      await writeMerchantThemeConfig({ themePath: fileURLToPath(new URL('../../shopify/theme/', import.meta.url)), outputPath: themePath, merchant: prepared.merchant });
    }
    return { status: 'private-preparation-complete', preparedSha256: prepared.preparedSha256, sourceSha256: prepared.sourceSha256,
      privatePlan: filename, privateTheme: themePath, pages: prepared.snapshot.pages.length, collections: prepared.snapshot.collections.length,
      publishedStyles: prepared.snapshot.products.length, heroOriginalVerified: Boolean(prepared.heroProof), remoteWrites: false, unpublishedOnly: true };
  } finally { if (ownsRuntime) await runtime.pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  const valueFlags = { '--input': 'input', '--plan': 'plan', '--reviewed-sha256': 'reviewedSha256', '--catalog': 'catalogPath' };
  try {
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (['--apply', '--theme'].includes(flag) && options[flag.slice(2)] == null) options[flag.slice(2)] = true;
      else if (valueFlags[flag] && options[valueFlags[flag]] == null && args[index + 1] && !args[index + 1].startsWith('--')) options[valueFlags[flag]] = args[++index];
      else throw new Error('Unsupported preparation arguments');
    }
    console.log(JSON.stringify(await prepareStore(options)));
  } catch {
    console.error(JSON.stringify({ status: 'failed', code: 'SHOPIFY_STORE_PREPARATION_REVIEW', message: 'Review the private prepared plan, current public source and exact original-image mapping before retrying' })); process.exitCode = 1;
  }
}
