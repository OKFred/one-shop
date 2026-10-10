import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ADOPTION_GRAPHQL, adoptionDigest, preparePublicPageAdoption, applyPublicPageAdoption, adoptPublicPages, validatePublicPageAdoptionPlan } from '../scripts/shopify/adopt-public-pages.mjs';
import { CONTENT_GRAPHQL, createContentSync } from '../scripts/shopify/sync-content.mjs';
import { PREPARATION_READ } from '../scripts/shopify/prepare-store.mjs';
import { validatePublicMerchantProfile } from '../scripts/merchant/public-profile.mjs';

const shop = 'synthetic-adoption.myshopify.com';
const flags = { SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_BRIDGE_WRITES_ENABLED: 'true', SHOPIFY_CONTENT_SYNC_ENABLED: 'true' };
const now = () => new Date('2026-10-10T12:00:00Z');
const expectedOwner = uuid => createHash('sha256').update(`page:${uuid}`).digest('hex');
const clone = value => structuredClone(value);
const withoutOwner = pages => pages.map(page => { const { owner, ...fields } = page; return fields; });

function harness() {
  const h = {
    native: ['about', 'contact'].map((handle, index) => ({ uuid: `10000000-0000-4000-8000-00000000900${index + 1}`, url_key: handle, name: handle === 'about' ? 'About SHUSHA' : 'Contact us', content: `<p>Synthetic native ${handle} public copy.</p>`, active: true })),
    remote: ['about', 'contact'].map((handle, index) => ({ id: `gid://shopify/OnlineStorePage/900${index + 1}`, handle, title: handle === 'about' ? 'About SHUSHA' : 'Contact us', body: `<p>Synthetic Shopify ${handle} public copy.</p>`, isPublished: true, templateSuffix: index ? 'contact' : null, owner: null })),
    profile: validatePublicMerchantProfile({ schemaVersion: 1, shopName: 'SHUSHA', address: { line1: '10 Example Street', city: 'Example City', country: 'Example Country', countryCode: 'ZZ' } }),
    mappings: new Map(), operations: new Map(), queries: [], mutations: [], locks: [], mappingWrites: 0, held: false, behavior: 'normal'
  };
  const store = {
    async withLock(key, work) { assert.equal(h.held, false); h.held = true; h.locks.push(key); try { return await work(); } finally { h.held = false; } },
    async get(key) { return clone(h.mappings.get(key) || null); },
    async put(key, record) { assert.equal(h.held, true); if (h.failMappingOnce && h.mappingWrites === 1) { h.failMappingOnce = false; throw new Error('Synthetic mapping connection lost'); } h.mappingWrites++; h.mappings.set(key, clone(record)); },
    async getOperation(key) { return clone(h.operations.get(key) || null); },
    async saveOperation(key, record) { assert.equal(h.held, true); h.operations.set(key, clone(record)); }
  };
  const client = { async request(document, variables = {}, options) {
    if (document === PREPARATION_READ.shop) { h.queries.push({ document, variables }); return { shop: { myshopifyDomain: h.remoteShop || shop } }; }
    if (document === ADOPTION_GRAPHQL.pages || document === CONTENT_GRAPHQL.pages) {
      h.queries.push({ document, variables });
      const handle = variables.query.slice('handle:'.length);
      return { pages: { nodes: clone(h.remote.filter(page => page.handle === handle)), pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    if (document === CONTENT_GRAPHQL.redirects) return { urlRedirects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    assert.equal(document, ADOPTION_GRAPHQL.setOwner);
    assert.equal(h.held, true); assert.deepEqual(options, { kind: 'mutation', safeRetry: false });
    assert.ok(variables.metafields.length <= 2);
    const batches = [...h.operations.values()].filter(row => row.kind === 'public-page-adoption' && row.metafields);
    const batch = batches.at(-1); assert.equal(batch.status, 'in-flight'); assert.deepEqual(batch.metafields, variables.metafields);
    for (const field of variables.metafields) {
      assert.deepEqual(Object.keys(field).sort(), ['compareDigest', 'key', 'namespace', 'ownerId', 'type', 'value']);
      assert.equal(field.compareDigest, null); assert.equal(field.namespace, 'shusha_bridge'); assert.equal(field.key, 'source_key'); assert.equal(field.type, 'single_line_text_field');
      const intent = h.operations.get(`public-page-adoption-intent:${shop}:${field.ownerId}`); assert.equal(intent.status, 'in-flight'); assert.equal(intent.planSha256, batch.planSha256);
    }
    h.mutations.push(clone(variables));
    if (h.behavior === 'lost-before') throw new Error('Synthetic private provider response must not be echoed');
    if (h.behavior === 'race-owner') h.remote[0].owner = { value: 'f'.repeat(64) };
    if (variables.metafields.some(field => h.remote.find(page => page.id === field.ownerId)?.owner !== null)) return { metafieldsSet: { metafields: [], userErrors: [{ code: 'INVALID_COMPARE_DIGEST', field: ['metafields'], message: 'Synthetic private CAS failure' }] } };
    for (const field of variables.metafields) h.remote.find(page => page.id === field.ownerId).owner = { value: field.value };
    if (h.behavior === 'source-race') h.native[0].name = 'Synthetic concurrent native title edit';
    if (h.behavior === 'lost-after') throw new Error('Synthetic private provider response must not be echoed');
    return { metafieldsSet: { metafields: variables.metafields.map(({ namespace, key, type, value }) => ({ namespace, key, type, value })), userErrors: [] } };
  } };
  h.runtime = { config: { enabled: true, writesEnabled: true, shop, scopes: ['read_content', 'write_content'] }, repositories: { mappings: store }, client, pool: { async query(sql, parameters) {
    assert.match(sql, /SELECT p\.uuid,d\.url_key,d\.name,d\.content/); assert.match(sql, /WHERE p\.status=TRUE AND d\.url_key=ANY\(\$1::text\[\]\)/); assert.match(sql, /LIMIT 3/);
    assert.ok(parameters[0].every(handle => ['about', 'contact'].includes(handle)));
    h.queries.push({ sql, parameters }); return { rows: clone(h.native.filter(row => row.active !== false && parameters[0].includes(row.url_key))) };
  } } };
  h.profileProvider = async () => clone(h.profile);
  h.prepare = (selectedHandles = ['about', 'contact']) => preparePublicPageAdoption({ runtime: h.runtime, env: flags, selectedHandles, profileProvider: h.profileProvider, now });
  h.apply = plan => applyPublicPageAdoption({ runtime: h.runtime, env: flags, plan, reviewedSha256: plan.planSha256, profileProvider: h.profileProvider, now });
  return h;
}

test('preparation explicitly selects existing about/contact, freezes both stores, and performs zero writes', async () => {
  const h = harness(); const plan = await h.prepare(['contact', 'about']);
  assert.deepEqual(plan.handles, ['about', 'contact']); assert.equal(validatePublicPageAdoptionPlan(plan, plan.planSha256), plan);
  assert.equal(plan.pages[0].source.sourceKey, `page:${h.native[0].uuid}`); assert.equal(plan.pages[0].ownerValue, expectedOwner(h.native[0].uuid));
  assert.equal(plan.pages[0].remote.body, h.remote[0].body); assert.notEqual(plan.pages[0].remote.body, plan.pages[0].source.body);
  assert.equal(plan.pages[0].remote.isPublished, true); assert.equal(plan.pageWrites, false); assert.equal(plan.dryRun, true);
  assert.equal(h.mutations.length, 0); assert.equal(h.mappingWrites, 0); assert.equal(h.operations.size, 0);
  assert.deepEqual(h.locks, [`content-sync:${shop}`]);
  assert.doesNotMatch(JSON.stringify(h.queries), /customer|receipt|bank|account_number/i);
});

test('implicit, unrelated, missing, duplicate, foreign-owned or previously remapped pages are refused', async () => {
  for (const selection of [undefined, [], ['about-us'], ['contact', 'contact'], ['about', 'contact', 'faq']]) {
    const h = harness(); await assert.rejects(preparePublicPageAdoption({ runtime: h.runtime, selectedHandles: selection }), /explicitly selected/); assert.equal(h.queries.length, 0);
  }
  for (const edit of [
    h => { h.native.pop(); }, h => { h.native.push(clone(h.native[0])); }, h => { h.remote.pop(); }, h => { h.remote.push(clone(h.remote[0])); },
    h => { h.remote[0].owner = { value: 'f'.repeat(64) }; }, h => { h.remoteShop = 'other.myshopify.com'; },
    h => { h.mappings.set(`page:${h.native[0].uuid}`, { id: 'gid://shopify/OnlineStorePage/9999', handle: 'about' }); },
    h => { h.mappings.set(`page:${h.native[0].uuid}`, { id: h.remote[0].id, handle: 'contact' }); }
  ]) {
    const h = harness(); edit(h); await assert.rejects(h.prepare()); assert.equal(h.mutations.length, 0); assert.equal(h.mappingWrites, 0);
  }
});

test('private frozen hash and every existing write flag gate execution before any mutation or journal', async () => {
  const h = harness(); const plan = await h.prepare();
  const changed = clone(plan); changed.pages[0].remote.body = '<p>Synthetic edited plan</p>';
  assert.throws(() => validatePublicPageAdoptionPlan(changed, plan.planSha256), /hash differs/);
  await assert.rejects(applyPublicPageAdoption({ runtime: h.runtime, env: flags, plan, reviewedSha256: 'a'.repeat(64), profileProvider: h.profileProvider }), /reviewed/);
  for (const flag of Object.keys(flags)) await assert.rejects(applyPublicPageAdoption({ runtime: h.runtime, env: { ...flags, [flag]: 'false' }, plan, reviewedSha256: plan.planSha256 }), /all content write flags/);
  h.runtime.config.writesEnabled = false; await assert.rejects(h.apply(plan), /all content write flags/);
  assert.equal(h.mutations.length, 0); assert.equal(h.operations.size, 0);
});

test('native Shopify safe target/rel link attributes are checked in a copy while exact original HTML stays frozen', async () => {
  const h = harness();
  const html = '<p>Contact support: <a href="https://wa.me/15555559001" target="_blank" rel="noopener noreferrer">WhatsApp &amp; support</a>.</p>';
  h.remote[1].body = html; const plan = await h.prepare(['contact']);
  assert.equal(plan.pages[0].remote.body, html); assert.equal(validatePublicPageAdoptionPlan(plan, plan.planSha256), plan);
  await h.apply(plan); assert.equal(h.remote[1].body, html); assert.equal(h.remote[1].isPublished, true);
  for (const bad of [
    '<p><a href="javascript:alert(1)" target="_blank" rel="noopener noreferrer">Unsafe</a></p>',
    '<p><a href="https://example.invalid" target="_self">Unsafe</a></p>',
    '<p><a href="https://example.invalid" target="_blank" rel="opener">Unsafe</a></p>',
    '<p><a href="https://example.invalid" target="_blank" rel="noopener noreferrer" onclick="alert(1)">Unsafe</a></p>',
    '<p><a href="https://wise.com/pay/synthetic" target="_blank" rel="noopener noreferrer">Private receiving</a></p>',
    '<p>Bank details: synthetic private routing number.</p>'
  ]) {
    const denied = harness(); denied.remote[1].body = bad; await assert.rejects(denied.prepare(['contact'])); assert.equal(denied.mutations.length, 0); assert.equal(denied.operations.size, 0);
  }
});

test('fresh source title/body/UUID/availability, remote content/identity/state and profile changes invalidate old review', async () => {
  for (const edit of [
    h => { h.native[0].name += ' changed'; }, h => { h.native[0].content += ' '; }, h => { h.native[0].uuid = '10000000-0000-4000-8000-000000009099'; }, h => { h.native[0].active = false; },
    h => { h.remote[0].title += ' changed'; }, h => { h.remote[0].body += ' '; }, h => { h.remote[0].handle = 'renamed-about'; },
    h => { h.remote[0].id = 'gid://shopify/OnlineStorePage/9999'; }, h => { h.remote[0].templateSuffix = 'about'; }, h => { h.remote[0].isPublished = false; },
    h => { h.remote[0].owner = { value: expectedOwner(h.native[0].uuid) }; }, h => { h.profile.address.line1 = '11 Example Street'; }
  ]) {
    const h = harness(); const plan = await h.prepare(); edit(h); await assert.rejects(h.apply(plan));
    assert.equal(h.mutations.length, 0); assert.equal(h.mappingWrites, 0); assert.equal(h.operations.size, 0);
  }
});

test('CAS ownership writes only metadata, preserves live content/template/visibility, and matches existing content sync ownership', async () => {
  const h = harness(); const original = withoutOwner(clone(h.remote)); const plan = await h.prepare(); const result = await h.apply(plan);
  assert.equal(result.ownerWrites, 2); assert.equal(result.pageContentWrites, false); assert.equal(result.publicationWrites, false);
  assert.deepEqual(withoutOwner(h.remote), original); assert.equal(h.mutations.length, 1);
  for (let index = 0; index < 2; index++) {
    assert.equal(h.remote[index].owner.value, expectedOwner(h.native[index].uuid));
    assert.equal(h.mappings.get(`page:${h.native[index].uuid}`).id, h.remote[index].id);
  }
  const sync = createContentSync({ graphql: h.runtime.client.request, stateStore: { get: h.runtime.repositories.mappings.get, put: h.runtime.repositories.mappings.put, withLock: async work => work() } });
  const preview = await sync.sync({ pages: h.native.map(row => ({ sourceUuid: row.uuid, handle: row.url_key, title: row.name, bodyHtml: row.content })) });
  assert.equal(preview.dryRun, true); assert.equal(h.mutations.length, 1); assert.deepEqual(withoutOwner(h.remote), original);
});

test('a concurrently created different owner causes atomic CAS rejection without touching any page copy or mapping', async () => {
  const h = harness(); const original = withoutOwner(clone(h.remote)); const plan = await h.prepare(); h.behavior = 'race-owner';
  await assert.rejects(h.apply(plan), /owner mutation was rejected/);
  assert.equal(h.remote[0].owner.value, 'f'.repeat(64)); assert.equal(h.remote[1].owner, null);
  assert.deepEqual(withoutOwner(h.remote), original); assert.equal(h.mappingWrites, 0);
  assert.equal(h.operations.get(`public-page-adoption:${shop}:${plan.planSha256}`).status, 'rejected');
});

test('lost mutation response recovers only through exact fresh owner readback and repeat execution is idempotent', async () => {
  const h = harness(); const original = withoutOwner(clone(h.remote)); const plan = await h.prepare(); h.behavior = 'lost-after';
  const recovered = await h.apply(plan); assert.equal(recovered.status, 'public-page-adoption-complete'); assert.equal(h.mappingWrites, 2); assert.equal(h.mutations.length, 1);
  const repeated = await h.apply(plan); assert.equal(repeated.resumed, true); assert.equal(repeated.ownerWrites, 0); assert.equal(h.mutations.length, 1);
  assert.deepEqual(withoutOwner(h.remote), original);
});

test('an unresolved lost write cannot be replayed or bypassed by preparing a fresh plan; eventual original readback resumes', async () => {
  const h = harness(); const plan = await h.prepare(); h.behavior = 'lost-before';
  await assert.rejects(h.apply(plan), /exact owner readback/); assert.equal(h.mutations.length, 1); assert.equal(h.mappingWrites, 0);
  await assert.rejects(h.apply(plan), /unknown writes are not replayed/); assert.equal(h.mutations.length, 1);
  await assert.rejects(h.prepare(), /earlier unresolved/);
  for (const field of h.mutations[0].metafields) h.remote.find(page => page.id === field.ownerId).owner = { value: field.value };
  const recovered = await h.apply(plan); assert.equal(recovered.resumed, true); assert.equal(recovered.ownerWrites, 0); assert.equal(h.mutations.length, 1); assert.equal(h.mappingWrites, 2);
});

test('post-write source changes freeze the intent without saving mappings or enabling another adoption', async () => {
  const h = harness(); const original = withoutOwner(clone(h.remote)); const plan = await h.prepare(); h.behavior = 'source-race';
  await assert.rejects(h.apply(plan), /unchanged current public page/); assert.equal(h.mappingWrites, 0); assert.equal(h.mutations.length, 1);
  assert.deepEqual(withoutOwner(h.remote), original); await assert.rejects(h.prepare(), /earlier unresolved/);
});

test('a durable metadata success survives a mapping connection loss and original plan completes without another provider write', async () => {
  const h = harness(); const plan = await h.prepare(); h.failMappingOnce = true;
  await assert.rejects(h.apply(plan), /mapping connection lost/); assert.equal(h.mappingWrites, 1); assert.equal(h.mutations.length, 1);
  const resumed = await h.apply(plan); assert.equal(resumed.resumed, true); assert.equal(resumed.ownerWrites, 0); assert.equal(h.mappings.size, 2); assert.equal(h.mutations.length, 1);
});

test('matching existing owner restores only the mapping and accepts both official observed page GID spellings', async () => {
  for (const typename of ['Page', 'OnlineStorePage']) {
    const h = harness(); h.remote[0].id = `gid://shopify/${typename}/9001`; h.remote[0].owner = { value: expectedOwner(h.native[0].uuid) };
    const plan = await h.prepare(['about']); const result = await h.apply(plan); assert.equal(result.ownerWrites, 0); assert.equal(h.mutations.length, 0); assert.equal(h.mappingWrites, 1);
  }
});

test('private CLI workflow emits counts/hash only and rejects path escape, symlink traversal and review replacement', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-adoption-synthetic-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'private'); const h = harness(); const env = { PRIVATE_DATA_DIR: root, ...flags };
  const options = { env, runtime: h.runtime, selectedHandles: ['contact'], profileProvider: h.profileProvider, now };
  const report = await adoptPublicPages(options); assert.equal(report.dryRun, true); assert.equal(report.remoteWrites, false); assert.equal(report.pages, 1);
  assert.doesNotMatch(JSON.stringify(report), /Example Street|public copy|<p>/); assert.equal(h.mutations.length, 0);
  const plan = JSON.parse(await fs.readFile(report.privatePlan, 'utf8')); assert.equal(validatePublicPageAdoptionPlan(plan, report.planSha256), plan);
  await assert.rejects(adoptPublicPages({ ...options, planFile: path.join(directory, 'outside.private.json') }), /private Shopify adoption/);
  await assert.rejects(adoptPublicPages({ ...options, apply: true, planFile: report.privatePlan, reviewedSha256: report.planSha256 }), /handles cannot replace/);
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(root, 'shopify/adoption/escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(adoptPublicPages({ ...options, planFile: path.join(root, 'shopify/adoption/escaped/leak.private.json') }), /cannot traverse symlinks/); assert.deepEqual(await fs.readdir(outside), []);
  const result = await adoptPublicPages({ env, runtime: h.runtime, apply: true, planFile: report.privatePlan, reviewedSha256: report.planSha256, profileProvider: h.profileProvider, now });
  assert.equal(result.pages, 1); assert.equal(h.remote[0].owner, null); assert.equal(h.remote[1].isPublished, true);
});

test('private root and higher ancestor symlinks are rejected before creating external nested directories or plans', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shusha-adoption-ancestor-synthetic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  const link = path.join(directory, 'private-link'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const root of [link, path.join(link, 'nested', 'private')]) {
    const h = harness();
    await assert.rejects(adoptPublicPages({ env: { ...flags, PRIVATE_DATA_DIR: root }, runtime: h.runtime, selectedHandles: ['contact'], profileProvider: h.profileProvider, now }), /cannot traverse symlinks/);
    assert.deepEqual(await fs.readdir(outside), []); assert.equal(h.mutations.length, 0); assert.equal(h.mappingWrites, 0);
  }
});

test('actual CLI help starts without environment credentials or runtime imports', () => {
  const result = spawnSync(process.execPath, ['scripts/shopify/adopt-public-pages.mjs', '--help'], { encoding: 'utf8', env: { ...process.env, SHOPIFY_BRIDGE_ENABLED: 'false', SHOPIFY_CLIENT_SECRET: '', SHOPIFY_TOKEN_ENCRYPTION_KEY: '' } });
  assert.equal(result.status, 0); assert.match(result.stdout, /--handles about,contact/); assert.match(result.stdout, /Unknown writes are read back, never replayed/); assert.equal(result.stderr, '');
});
