import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizePublicContent, validatePreparationInput, buildStorePreparation, validatePreparedStore,
  applyPreparedStore, prepareStore, verifyHeroOriginal } from '../scripts/shopify/prepare-store.mjs';

const shop = 'synthetic-preparation.myshopify.com';
const sourceUuid = '11000000-0000-4000-8000-000000000001';
const pageUuid = '11000000-0000-4000-8000-000000000002';
const categoryIds = ['12000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000003'];
const categories = ['dresses', 'pants', 'tops'];
const fixedNow = () => new Date('2026-10-10T00:00:00Z');
const flags = { SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_BRIDGE_WRITES_ENABLED: 'true', SHOPIFY_CONTENT_SYNC_ENABLED: 'true' };
const input = () => ({ schemaVersion: 1, approvedPageHandles: ['about'], hero: { heading: 'Synthetic store' }, footer: {}, support: {} });
function snapshot() {
  return { products: [{ sourceUuid, handle: 'l9001', status: 'PUBLISHED', shopifyGid: 'gid://shopify/Product/9001', publishedAt: '2026-10-01T00:00:00Z' }],
    collections: categories.map((handle, index) => ({ sourceUuid: categoryIds[index], handle, title: handle, descriptionHtml: '<p>Already normalized</p>', productUuids: index === 0 ? [sourceUuid] : [] })), pages: [], menus: [], redirects: [] };
}
function harness() {
  const sql = []; const graphql = []; const locks = []; const operations = new Map();
  const raw = categories.map((url_key, index) => ({ uuid: categoryIds[index], url_key, description: '<p>Synthetic category</p>' }));
  let pages = [{ uuid: pageUuid, url_key: 'about', name: 'About', content: '<p>Synthetic public information</p>' }];
  let publication = null; let media = null; let remoteFile = null;
  const runtime = { config: { shop, enabled: true, writesEnabled: true }, pool: { async query(query, values) {
    sql.push({ query, values });
    assert.doesNotMatch(query, /\b(?:FROM|JOIN)\s+"?(?:customer|order|bank_transfer|receiving|receipt)\b/i);
    assert.doesNotMatch(query, /SELECT\s+\*/i);
    if (/FROM cms_page/.test(query)) return { rows: pages };
    if (/FROM category/.test(query)) return { rows: raw };
    if (/FROM shusha_material_publication/.test(query)) return { rows: publication ? [publication] : [] };
    throw new Error('Unexpected synthetic source query');
  } }, client: { async request(document, variables) {
    graphql.push({ document, variables }); assert.match(document, /^query /);
    if (/ShushaPreparationShop/.test(document)) return { shop: { myshopifyDomain: shop } };
    if (/ShushaPreparationMedia/.test(document)) return { node: remoteFile };
    throw new Error('Unexpected synthetic Shopify read');
  } }, repositories: { mappings: {
    async withLock(key, callback) { locks.push(key); return callback(); },
    async getOperation(key) { return operations.get(key); }, async saveOperation(key, value) { operations.set(key, structuredClone(value)); },
    async get() { return null; }, async put() {}, async getMedia() { return media; }
  } } };
  return { runtime, sql, graphql, locks, operations, raw, set pages(value) { pages = value; },
    set publication(value) { publication = value; }, set media(value) { media = value; }, set remoteFile(value) { remoteFile = value; } };
}
const build = (h, options = {}) => buildStorePreparation({ runtime: h.runtime, input: input(), snapshotProvider: async () => snapshot(), now: fixedNow, ...options });

test('preparation preserves native category/page identities and canonical product redirects with only bounded public reads', async () => {
  const h = harness(); const prepared = await build(h);
  assert.deepEqual(prepared.plan.collections.map(row => row.sourceKey), categoryIds.map(id => `collection:${id}`));
  assert.equal(prepared.plan.pages[0].sourceKey, `page:${pageUuid}`);
  assert.equal(prepared.plan.pages[0].isPublished, false);
  assert.equal(prepared.plan.collections[0].descriptionHtml, '<p>Synthetic category</p>');
  assert.ok(prepared.plan.redirects.some(row => row.path === '/dresses/l9001' && row.target === '/products/l9001'));
  assert.deepEqual(prepared.plan.menus.map(row => row.handle), ['shusha-main', 'shusha-footer']);
  assert.deepEqual(h.sql.find(row => /FROM cms_page/.test(row.query)).values, [['about']]);
  assert.equal(prepared.customerRecords, 0); assert.equal(prepared.historicalOrders, 0);
  assert.equal(validatePreparedStore(prepared, prepared.preparedSha256), prepared);
});

test('CMS conversion refuses unsupported or private markup instead of silently stripping it', () => {
  const editor = blocks => JSON.stringify([{ columns: [{ data: { blocks } }] }]);
  assert.equal(normalizePublicContent(editor([{ type: 'header', data: { level: 2, text: 'Public information' } }, { type: 'paragraph', data: { text: '<b>Orders</b> are requests.' } }])), '<h2>Public information</h2>\n<p><strong>Orders</strong> are requests.</p>');
  assert.equal(normalizePublicContent('<p><a href="/shipping">Shipping</a></p>'), '<p><a href="/shipping">Shipping</a></p>');
  for (const bad of ['<p style="color:red">text</p>', '<img src="/private.png">', '<script>bad()</script>', '<p onclick="bad()">text</p>', '<a href="https://wise.com/pay/synthetic">Pay</a>', '<a href="/account/orders">Private</a>', '<p>Account number: synthetic</p>', '<!-- hidden -->text', editor([{ type: 'image', data: { url: '/synthetic.png' } }]), '{"not":"rows"}', editor([{ type: 'list', data: { style: 'unordered', items: [{ content: 'nested' }] } }])]) {
    assert.throws(() => normalizePublicContent(bad), /public|Public|Receiving|Unsupported|Ambiguous|Private/);
  }
  assert.throws(() => validatePreparationInput({ ...input(), approvedPageHandles: ['payment'] }), /allowlist/);
  assert.throws(() => validatePreparationInput({ ...input(), bankDetails: [] }), /unsupported field/);
  assert.throws(() => validatePreparationInput({ ...input(), hero: { image: 'shopify://shop_images/arbitrary.png' } }), /unsupported field/);
});

test('ambiguous pages, raw native category HTML and READY catalog members are refused', async () => {
  const h = harness(); h.pages = [];
  await assert.rejects(build(h), /selected public page/);
  h.pages = [{ uuid: pageUuid, url_key: 'about', name: 'About', content: '<p>Public</p>' }];
  h.raw[0].description = '<p class="widget">Previously stripped style</p>';
  await assert.rejects(build(h), /Unsupported public HTML/);
  h.raw[0].description = '';
  const ready = snapshot(); ready.products[0].status = 'READY';
  await assert.rejects(build(h, { snapshotProvider: async () => ready }), /actual native published/);
  const twoCategories = snapshot(); twoCategories.collections[1].productUuids = [sourceUuid];
  await assert.rejects(build(h, { snapshotProvider: async () => twoCategories }), /one canonical/);
});

test('explicit reviewed hash, feature flags and current source proof gate all content mutations', async () => {
  const h = harness(); const prepared = await build(h); let writes = 0;
  const factory = () => ({ async sync() { writes++; return {}; } });
  const options = { runtime: h.runtime, prepared, reviewedSha256: prepared.preparedSha256, reload: () => build(h), synchronizerFactory: factory };
  await assert.rejects(applyPreparedStore(options), /runtime enablement/);
  await assert.rejects(applyPreparedStore({ ...options, env: flags, reviewedSha256: 'f'.repeat(64) }), /hash differs/);
  const tampered = structuredClone(prepared); tampered.snapshot.pages[0].bodyHtml = '<p>Changed</p>';
  assert.throws(() => validatePreparedStore(tampered), /hash differs/);
  h.pages = [{ uuid: pageUuid, url_key: 'about', name: 'About', content: '<p>New source text</p>' }];
  await assert.rejects(applyPreparedStore({ ...options, env: flags }), /source.*changed/);
  assert.equal(writes, 0); assert.equal(h.operations.size, 0);
});

test('content apply uses the shared follower lock and frozen unpublished input; failed writes retain the journal', async () => {
  const h = harness(); const prepared = await build(h); let fail = true;
  const synchronizerFactory = ({ stateStore }) => ({ async sync(source, options) {
    assert.deepEqual(source, prepared.snapshot); assert.deepEqual(options, { dryRun: false, publishPages: false });
    await stateStore.withLock(async () => assert.equal(h.locks.length, 1));
    if (fail) throw new Error('Synthetic unknown readback');
    return { pages: 1, collections: 3, menus: 2, redirects: 5 };
  } });
  const options = { runtime: h.runtime, env: flags, prepared, reviewedSha256: prepared.preparedSha256, reload: () => build(h), synchronizerFactory };
  await assert.rejects(applyPreparedStore(options), /unknown readback/);
  assert.equal(h.operations.get(`store-preparation:${prepared.preparedSha256}`).status, 'pending');
  fail = false; h.locks.length = 0;
  const result = await applyPreparedStore(options);
  assert.deepEqual(h.locks, [`content-sync:${shop}`]);
  assert.equal(result.status, 'unpublished-content-synchronized'); assert.equal(result.themeWrites, false); assert.equal(result.publishWrites, false);
  assert.equal(h.operations.get(`store-preparation:${prepared.preparedSha256}`).status, 'complete');
});

async function originalFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-prepare-synthetic-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XgnsAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(png).digest('hex');
  const image = { sha256, localPath: `media/source-library/${sha256}.png`, bytes: png.length, alt: 'Synthetic original' };
  await fs.writeFile(path.join(directory, `${sha256}.png`), png);
  const unsigned = { schemaVersion: 1, currency: 'USD', pricePolicy: 'source-resale-usd-times-1.1-ceiling-.99', capturedAt: fixedNow().toISOString(),
    styles: [{ sourceId: 'L9001', sourceUuid, handle: 'l9001', category: 'dresses', title: 'Synthetic Dress', descriptionHtml: '<p>Synthetic</p>', images: [image],
      variants: [{ uuid: sourceUuid, sku: 'SHUSHA-L9001', sourceVariantSku: 'SYN-RED-S', color: 'Red', size: 'S', sourceUsd: '10.00', retailUsd: '11.99', remainingCapacity: 12, imageHashes: [sha256] }] }] };
  const catalog = { ...unsigned, contentSha256: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') };
  const filename = `shusha-${sha256}.png`; const h = harness();
  h.publication = { uuid: sourceUuid, plan: { sourceId: 'L9001', category: 'dresses', review: { ready: true, reviewedAt: '2026-10-01T00:00:00Z', reviewedSourceSha256: 'a'.repeat(64) }, variants: [{ images: [image] }] } };
  h.media = { sha256, filename, gid: 'gid://shopify/MediaImage/9001' };
  h.remoteFile = { id: 'gid://shopify/MediaImage/9001', fileStatus: 'READY', status: 'READY', image: { url: `https://cdn.shopify.com/s/files/1/9001/files/${filename}?v=1` } };
  return { h, directory, catalog, image, filename, selection: { sourceUuid, sha256 } };
}

test('hero resolves only a hash-verified local original with current review and live READY uploaded identity', async t => {
  const f = await originalFixture(t);
  const options = { runtime: f.h.runtime, selection: f.selection, catalog: f.catalog, mediaRoot: f.directory };
  const verified = await verifyHeroOriginal(options);
  assert.equal(verified.image, `shopify://shop_images/${f.filename}`); assert.equal(verified.sha256, f.image.sha256);
  assert.equal('bytesBuffer' in verified, false);
  f.h.remoteFile = { id: 'gid://shopify/MediaImage/9001', fileStatus: 'PROCESSING', status: 'PROCESSING', image: null };
  await assert.rejects(verifyHeroOriginal(options), /not READY/);
  f.h.remoteFile = { id: 'gid://shopify/MediaImage/9001', fileStatus: 'READY', status: 'READY', image: { url: 'https://cdn.shopify.com/s/files/synthetic-unowned.png' } };
  await assert.rejects(verifyHeroOriginal(options), /filename/);
  f.h.remoteFile = { id: 'gid://shopify/MediaImage/9001', fileStatus: 'READY', status: 'READY', image: { url: `https://cdn.shopify.com/s/files/${f.filename}` } };
  await fs.writeFile(path.join(f.directory, `${f.image.sha256}.png`), Buffer.alloc(f.image.bytes));
  await assert.rejects(verifyHeroOriginal(options), /content hash differs/);
});

test('hero selection cannot substitute a different media mapping or obsolete unreviewed publication', async t => {
  const f = await originalFixture(t); const options = { runtime: f.h.runtime, selection: f.selection, catalog: f.catalog, mediaRoot: f.directory };
  f.h.media = { sha256: f.image.sha256, filename: 'unverified.png', gid: 'gid://shopify/MediaImage/9001' };
  await assert.rejects(verifyHeroOriginal(options), /exact existing/);
  f.h.publication = { uuid: sourceUuid, plan: { sourceId: 'L9001', category: 'dresses', review: { ready: false }, variants: [] } };
  await assert.rejects(verifyHeroOriginal(options), /reviewed READY/);
});

test('default CLI workflow writes only an immutable private plan and separate unpublished theme', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-private-preparation-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const h = harness(); const env = { PRIVATE_DATA_DIR: directory };
  const result = await prepareStore({ env, runtime: h.runtime, theme: true, snapshotProvider: async () => snapshot(), now: fixedNow });
  assert.equal(result.remoteWrites, false); assert.equal(result.unpublishedOnly, true); assert.equal(result.pages, 0);
  const saved = JSON.parse(await fs.readFile(result.privatePlan, 'utf8'));
  assert.equal(validatePreparedStore(saved, result.preparedSha256), saved);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.privateTheme, 'sections/header-group.json'), 'utf8')).sections.header.settings.menu, 'shusha-main');
  assert.deepEqual(h.locks, [`content-sync:${shop}`]); assert.equal(h.operations.size, 0);
  await assert.rejects(prepareStore({ env, runtime: h.runtime, apply: true }), /--plan and --reviewed-sha256/);
  await assert.rejects(prepareStore({ env, runtime: h.runtime, plan: path.join(directory, 'outside.private.json'), snapshotProvider: async () => snapshot(), now: fixedNow }), /under private Shopify data/);
});

test('private preparation refuses a symlink/junction path that would write outside its private root', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-private-boundary-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'private'); const outside = path.join(directory, 'other');
  await fs.mkdir(path.join(root, 'shopify'), { recursive: true }); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'shopify', 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  const h = harness();
  await assert.rejects(prepareStore({ env: { PRIVATE_DATA_DIR: root }, runtime: h.runtime, plan: path.join(root, 'shopify/escaped/leak.private.json'), snapshotProvider: async () => snapshot(), now: fixedNow }), /cannot traverse symlinks/);
  assert.deepEqual(await fs.readdir(outside), []);
});
