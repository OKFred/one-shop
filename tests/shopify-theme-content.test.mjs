import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildContentPlan, sanitizeContentHtml, createContentSync, computeCollectionMoves, writeMerchantThemeConfig } from '../scripts/shopify/sync-content.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const pageInfo = { hasNextPage: false, endCursor: null };
function snapshot() {
  return {
    products: [
      { sourceUuid: 'synthetic-old', handle: 'l9001', categoryHandle: 'dresses', shopifyGid: 'gid://shopify/Product/1', status: 'PUBLISHED', publishedAt: '2026-01-01T00:00:00Z' },
      { sourceUuid: 'synthetic-new', handle: 'l9002', categoryHandle: 'dresses', shopifyGid: 'gid://shopify/Product/2', status: 'PUBLISHED', publishedAt: '2026-01-02T00:00:00Z' },
      { sourceUuid: 'synthetic-ready', handle: 'l9003', categoryHandle: 'dresses', shopifyGid: 'gid://shopify/Product/3', status: 'READY', publishedAt: '2026-01-03T00:00:00Z' }
    ],
    pages: [{ sourceUuid: 'synthetic-information', handle: 'information', title: 'Information', bodyHtml: '<p>Order requests</p>' }],
    collections: [{ sourceUuid: 'synthetic-category', handle: 'dresses', title: 'Dresses', descriptionHtml: '<p>Synthetic collection</p>', productUuids: ['synthetic-old', 'synthetic-new', 'synthetic-ready'] }],
    menus: [{ handle: 'shusha-main', title: 'SHUSHA main', items: [{ title: 'Dresses', type: 'collection', handle: 'dresses' }] }]
  };
}

function harness() {
  const state = new Map(), remote = { pages: [], collections: [], menus: [], redirects: [] }, writes = [];
  let id = 10, losePageResponse = false;
  const store = { get: key => state.get(key), put: (key, value) => state.set(key, value), withLock: callback => callback() };
  async function graphql(query, variables) {
    const operation = query.match(/(?:query|mutation) (\w+)/)[1];
    if (query.startsWith('mutation')) writes.push(operation);
    const owned = input => ({ ...input, owner: { value: input.metafields[0].value } });
    if (operation === 'ShushaContentPages') return { pages: { nodes: remote.pages.filter(p => p.handle === variables.query.split(':')[1]), pageInfo } };
    if (operation === 'ShushaContentCollections') return { collections: { nodes: remote.collections.filter(c => c.handle === variables.query.split(':')[1]), pageInfo } };
    if (operation === 'ShushaContentMenus') return { menus: { nodes: remote.menus, pageInfo } };
    if (operation === 'ShushaContentRedirects') return { urlRedirects: { nodes: remote.redirects.filter(r => r.path === variables.query.slice(5)), pageInfo } };
    if (operation === 'ShushaPageCreate') {
      const page = { id: `gid://shopify/Page/${id++}`, ...owned(variables.page) }; remote.pages.push(page);
      if (losePageResponse) { losePageResponse = false; throw new Error('Synthetic response loss'); }
      return { pageCreate: { page, userErrors: [] } };
    }
    if (operation === 'ShushaPageUpdate') {
      const page = remote.pages.find(p => p.id === variables.id); Object.assign(page, owned(variables.page)); return { pageUpdate: { page, userErrors: [] } };
    }
    if (operation === 'ShushaCollectionCreate') {
      const input = variables.collection;
      const collection = { id: `gid://shopify/Collection/${id++}`, ...owned(input), sources: [{ id: `gid://shopify/CollectionConditionsSource/${id++}`, title: input.sources[0].source.title, __typename: 'CollectionConditionsSource' }], selected: input.sources[0].source.inclusion.selections.map(s => s.productId) };
      collection.order = [...collection.selected].reverse(); remote.collections.push(collection);
      return { collectionCreate: { collection, userErrors: [] } };
    }
    if (operation === 'ShushaSourceSelections') { const c = remote.collections.find(c => c.sources[0].id === variables.id); return { node: { inclusion: { selections: { nodes: c.selected.map(id => ({ product: { id } })), pageInfo } } } }; }
    if (operation === 'ShushaCollectionProducts') { const c = remote.collections.find(c => c.id === variables.id); return { collection: { products: { nodes: c.order.map(id => ({ id })), pageInfo } } }; }
    if (operation === 'ShushaCollectionUpdate') {
      const c = remote.collections.find(c => c.id === variables.collection.id);
      Object.assign(c, owned(variables.collection));
      const change = variables.collection.sourcesToUpdate?.[0]?.condition.inclusion;
      if (change) { c.selected = c.selected.filter(id => !change.selectionsToRemove.some(s => s.productId === id)); for (const s of change.selectionsToAdd) if (!c.selected.includes(s.productId)) c.selected.push(s.productId); c.order = c.order.filter(id => c.selected.includes(id)); for (const id of c.selected) if (!c.order.includes(id)) c.order.push(id); }
      return { collectionUpdate: { collection: c, userErrors: [] } };
    }
    if (operation === 'ShushaCollectionReorder') { const c = remote.collections.find(c => c.id === variables.id); for (const move of variables.moves) { c.order.splice(c.order.indexOf(move.id), 1); c.order.splice(Number(move.newPosition), 0, move.id); } return { collectionReorderProducts: { job: { id: 'gid://shopify/Job/1', done: true }, userErrors: [] } }; }
    if (operation === 'ShushaMenuCreate') { const menu = { ...variables, id: `gid://shopify/Menu/${id++}` }; remote.menus.push(menu); return { menuCreate: { menu, userErrors: [] } }; }
    if (operation === 'ShushaMenuUpdate') { const menu = remote.menus.find(m => m.id === variables.id); Object.assign(menu, variables); return { menuUpdate: { menu, userErrors: [] } }; }
    if (operation === 'ShushaRedirectCreate') { const urlRedirect = { ...variables.urlRedirect, id: `gid://shopify/UrlRedirect/${id++}` }; remote.redirects.push(urlRedirect); return { urlRedirectCreate: { urlRedirect, userErrors: [] } }; }
    throw new Error(`Unsupported synthetic operation ${operation}`);
  }
  return { graphql, stateStore: store, remote, writes, losePageResponse: () => { losePageResponse = true; } };
}

test('published source styles alone drive collections and native redirects', () => {
  const plan = buildContentPlan(snapshot());
  assert.deepEqual(plan.collections[0].productIds, ['gid://shopify/Product/2', 'gid://shopify/Product/1']);
  assert.equal(plan.pages[0].isPublished, false);
  assert(!plan.redirects.some(r => r.path.includes('l9003')));
  assert(plan.redirects.some(r => r.path === '/dresses/l9002' && r.target === '/products/l9002'));
});

test('CMS parser strips executable markup, original image embeds and unsafe links', () => {
  const html = sanitizeContentHtml('<script>secret()</script><p onclick="bad()" style="color:red">Text<img src="https://supplier.invalid/image.jpg"><a href="javascript:alert(1)">bad</a><a href="/shipping-payment">safe</a><a href="//evil.invalid">no</a><a href="/\\evil.invalid">no</a></p><iframe src="x"></iframe>');
  assert.equal(html, '<p>Text<a>bad</a><a href="/shipping-payment">safe</a><a>no</a><a>no</a></p>');
});

test('native route takeover, invalid identity, nested menus and unmatched destinations fail closed', () => {
  assert.throws(() => buildContentPlan({ ...snapshot(), redirects: [{ path: '/account', target: '/pages/information' }] }), /Native routes/);
  assert.throws(() => buildContentPlan({ ...snapshot(), redirects: [{ path: '/old', target: '/products/l9003' }] }), /exported/);
  assert.throws(() => buildContentPlan({ ...snapshot(), menus: [{ handle: 'main-menu', title: 'Main', items: [] }] }), /merchant-owned/);
  const bad = snapshot(); bad.products[0].publishedAt = 'unknown'; assert.throws(() => buildContentPlan(bad), /publication time/);
});

test('default dry run never writes or publishes', async () => {
  const h = harness(); const result = await createContentSync(h).sync(snapshot());
  assert.equal(result.dryRun, true); assert.equal(h.writes.length, 0); assert.equal(h.remote.pages.length, 0);
});

test('repeated full content sync creates no duplicates and preserves newest-first order', async () => {
  const h = harness(); const sync = createContentSync(h);
  await sync.sync(snapshot(), { dryRun: false });
  assert.deepEqual(h.remote.collections[0].order, ['gid://shopify/Product/2', 'gid://shopify/Product/1']);
  assert.equal(h.remote.pages[0].isPublished, false);
  const count = h.writes.length;
  await sync.sync(snapshot(), { dryRun: false });
  assert.equal(h.writes.length, count);
  assert.equal(h.remote.pages.length, 1); assert.equal(h.remote.collections.length, 1); assert.equal(h.remote.menus.length, 1); assert.equal(h.remote.redirects.length, 4);
});

test('a lost create response recovers the owned page through remote readback', async () => {
  const h = harness(); h.losePageResponse(); const sync = createContentSync(h);
  await assert.rejects(sync.sync(snapshot(), { dryRun: false }), /response loss/);
  assert.equal(h.remote.pages.length, 1);
  await sync.sync(snapshot(), { dryRun: false });
  assert.equal(h.remote.pages.length, 1); assert.equal(h.writes.filter(w => w === 'ShushaPageCreate').length, 1);
});

test('unmanaged pages cannot be adopted through a matching handle', async () => {
  const h = harness(); h.remote.pages.push({ id: 'gid://shopify/Page/99', handle: 'information', title: 'Other page', owner: { value: digest('another-owner') } });
  await assert.rejects(createContentSync(h).sync(snapshot(), { dryRun: false }), /unmanaged/);
  assert.equal(h.writes.length, 0);
});

test('collection deltas only change reviewed membership and explicit publication controls pages', async () => {
  const h = harness(); const sync = createContentSync(h); await sync.sync(snapshot(), { dryRun: false });
  const updated = snapshot(); updated.collections[0].productUuids = ['synthetic-new', 'synthetic-ready'];
  await sync.sync(updated, { dryRun: false, publishPages: true });
  assert.deepEqual(h.remote.collections[0].selected, ['gid://shopify/Product/2']);
  assert.deepEqual(h.remote.collections[0].order, ['gid://shopify/Product/2']);
  assert.equal(h.remote.pages[0].isPublished, true);
});

test('collection moves use current sequential positions, not full product rewrites', () => {
  assert.deepEqual(computeCollectionMoves(['a', 'b', 'c'], ['c', 'a', 'b']), [{ id: 'c', newPosition: '0' }]);
  assert.throws(() => computeCollectionMoves(['a'], ['b']), /membership/);
});

test('native theme keeps licenses, no embedded Git, offline icons and cart preference', async () => {
  const base = path.resolve('shopify/theme');
  assert.match(await readFile(path.join(base, 'LICENSE.md'), 'utf8'), /Copyright \(c\) 2021-present Shopify Inc\./);
  assert.match(await readFile(path.join(base, 'LICENSE.md'), 'utf8'), /integrate or interoperate with Shopify software or services/);
  assert(!(await readdir(base)).includes('.git'));
  const buy = await readFile(path.join(base, 'snippets/buy-buttons.liquid'), 'utf8');
  const cart = await readFile(path.join(base, 'sections/main-cart-footer.liquid'), 'utf8');
  assert(!buy.includes('| payment_button')); assert(!cart.includes('content_for_additional_checkout_buttons'));
  assert.match(await readFile(path.join(base, 'snippets/shusha-courier-preference.liquid'), 'utf8'), /name="attributes\[Preferred courier\]" form="cart" maxlength="80"/);
  for (const name of ['wise', 'whatsapp']) assert.match(await readFile(path.join(base, `assets/shusha-icon-${name}.svg`), 'utf8'), /<path fill="currentColor"/);
  const settings = JSON.parse(await readFile(path.join(base, 'config/settings_data.json'), 'utf8'));
  assert.equal(settings.current.cart_type, 'page'); assert.equal(settings.current.shusha_whatsapp_sri_lanka, '');
});

test('pagination examines all navigation before allowing a handle to be created', async () => {
  const h = harness(); const data = snapshot(); data.pages = []; data.collections = []; data.products = []; data.menus[0].items = [];
  let menusRead = 0;
  const graphql = async (query, variables) => {
    if (query.includes('query ShushaContentMenus')) {
      menusRead++;
      return { menus: variables.after ? { nodes: [{ id: 'gid://shopify/Menu/500', handle: 'shusha-main', title: 'Unmanaged navigation', items: [] }], pageInfo } : { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'synthetic-next' } } };
    }
    return h.graphql(query, variables);
  };
  await assert.rejects(createContentSync({ ...h, graphql }).sync(data, { dryRun: false }), /unmanaged/);
  assert.equal(menusRead, 2); assert.equal(h.writes.length, 0);
});

test('a pending collection job does not mark synchronization complete', async () => {
  const h = harness(); const sync = createContentSync(h); await sync.sync(snapshot(), { dryRun: false });
  const changed = snapshot(); changed.collections[0].productUuids = ['synthetic-new'];
  const graphql = async (query, variables) => {
    const response = await h.graphql(query, variables);
    if (response.collectionUpdate) response.collectionUpdate.job = { id: 'gid://shopify/Job/500', done: false };
    return response;
  };
  await assert.rejects(createContentSync({ ...h, graphql }).sync(changed, { dryRun: false }), /job is pending/);
  // The mutation can have reached Shopify before an unknown response. The
  // original desired snapshot safely resumes through current membership.
  await sync.sync(changed, { dryRun: false });
  assert.deepEqual(h.remote.collections[0].order, ['gid://shopify/Product/2']);
});

test('a changed private mapped ID and extra collection sources require investigation', async () => {
  const h = harness(); const sync = createContentSync(h); await sync.sync(snapshot(), { dryRun: false });
  h.remote.pages[0].id = 'gid://shopify/Page/999';
  await assert.rejects(sync.sync(snapshot(), { dryRun: false }), /identity changed/);
  h.remote.pages[0].id = (await h.stateStore.get('page:synthetic-information')).id;
  h.remote.collections[0].sources.push({ id: 'gid://shopify/CollectionConditionsSource/999', title: 'Merchant special selection', __typename: 'CollectionConditionsSource' });
  await assert.rejects(sync.sync(snapshot(), { dryRun: false }), /sources changed/);
});

test('merchant theme configuration is written only to a separate private copy', async () => {
  const parent = path.resolve('private', `shopify-theme-synthetic-${process.pid}-${Date.now()}`);
  const output = path.join(parent, 'theme'); await mkdir(parent, { recursive: true });
  try {
    const source = path.resolve('shopify/theme');
    const before = await readFile(path.join(source, 'templates/index.json'), 'utf8');
    await assert.rejects(writeMerchantThemeConfig({ themePath: source, outputPath: source, merchant: {} }), /separate private directory/);
    const result = await writeMerchantThemeConfig({ themePath: source, outputPath: output, merchant: { hero: { heading: 'Synthetic headline', descriptionHtml: '<p onclick="bad()">Synthetic copy</p>', image: 'shopify://shop_images/synthetic.jpg' }, support: { whatsappSriLanka: 'https://wa.me/12345678901' } } });
    assert.equal(result.unpublishedOnly, true);
    const generated = JSON.parse(await readFile(path.join(output, 'templates/index.json'), 'utf8'));
    assert.equal(generated.sections.hero.settings.heading, 'Synthetic headline');
    assert.equal(generated.sections.hero.settings.description, '<p>Synthetic copy</p>');
    assert.equal(await readFile(path.join(source, 'templates/index.json'), 'utf8'), before);
    await assert.rejects(writeMerchantThemeConfig({ themePath: source, outputPath: output, merchant: {} }), /already exists/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
