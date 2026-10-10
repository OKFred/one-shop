#!/usr/bin/env node
// Explicit merchant-reviewed association of existing public About/Contact pages.
// Default: private dry-run plan. This never creates pages or changes their copy,
// handles, templates or publication state. No credentials or page bodies log.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildContentPlan, CONTENT_GRAPHQL } from './sync-content.mjs';
import { normalizePublicContent, PREPARATION_READ } from './prepare-store.mjs';
import { loadPublicMerchantProfile, validatePublicMerchantProfile } from '../merchant/public-profile.mjs';

export const ADOPTION_GRAPHQL = Object.freeze({
  pages: CONTENT_GRAPHQL.pages,
  setOwner: `mutation ShushaAdoptPublicPages($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { namespace key type value }
      userErrors { field code message }
    }
  }`
});
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PAGE = /^gid:\/\/shopify\/(?:Page|OnlineStorePage)\/[1-9]\d*$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const canonical = value => JSON.stringify(value, (_key, item) => plain(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const adoptionDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const ownerValue = sourceKey => createHash('sha256').update(sourceKey).digest('hex');
const intentKey = (shop, id) => `public-page-adoption-intent:${shop}:${id}`;
const operationKey = (shop, digest) => `public-page-adoption:${shop}:${digest}`;
// Resolve the explicitly pinned bridge dependency from its owning workspace;
// both nested and hoisted npm installs work without changing upstream packages.
const require = createRequire(new URL('../../extensions/shopify-bridge/package.json', import.meta.url));
const { Parser } = require('htmlparser2');
const escapeAttribute = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function handles(input) {
  requireValue(Array.isArray(input) && input.length > 0 && input.length <= 2 && new Set(input).size === input.length && input.every(handle => ['about', 'contact'].includes(handle)), 'Adoption requires explicitly selected about/contact handles');
  return [...input].sort();
}
function text(value, label, maximum = 200) {
  requireValue(typeof value === 'string' && value.length <= maximum && !/[\p{Cc}\p{Cf}]/u.test(value), `Invalid public ${label}`);
  return value;
}
function safeBody(value) {
  requireValue(typeof value === 'string' && Buffer.byteLength(value) <= 256 * 1024, 'Invalid bounded public page body');
  // Shopify's native rich text editor adds safe link target/rel attributes.
  // Strip only those attributes in an isolated validation copy, keeping raw HTML
  // unchanged for review, hashes and all fresh readbacks. Every other attribute,
  // URL, tag and private receiving-data rule still goes through the shared gate.
  const replacements = []; let parser;
  parser = new Parser({ onopentag(name, attributes) {
    if (name !== 'a' || !Object.hasOwn(attributes, 'target') && !Object.hasOwn(attributes, 'rel')) return;
    if (Object.hasOwn(attributes, 'target')) requireValue(attributes.target === '_blank', 'Unsupported public link target');
    if (Object.hasOwn(attributes, 'rel')) requireValue(attributes.rel.trim() && attributes.rel.trim().split(/\s+/).every(token => ['noopener', 'noreferrer'].includes(token)), 'Unsupported public link relation');
    const checked = { ...attributes }; delete checked.target; delete checked.rel;
    replacements.push({ start: parser.startIndex, end: parser.endIndex + 1, html: `<a${Object.entries(checked).map(([key, entry]) => ` ${key}="${escapeAttribute(entry)}"`).join('')}>` });
  } }, { decodeEntities: true });
  parser.end(value);
  let checked = value;
  for (const replacement of replacements.reverse()) checked = checked.slice(0, replacement.start) + replacement.html + checked.slice(replacement.end);
  normalizePublicContent(checked);
  return value;
}
function validateRuntime(runtime) {
  requireValue(runtime?.config?.enabled === true && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(runtime.config.shop || '') && runtime?.pool?.query && runtime?.client?.request, 'An enabled authenticated store runtime is required');
  const store = runtime.repositories?.mappings;
  requireValue(store?.withLock && store?.get && store?.put && store?.getOperation && store?.saveOperation, 'Durable exclusively locked content mappings are required');
  return store;
}
function assertWrites(runtime, env) {
  requireValue(env.SHOPIFY_BRIDGE_ENABLED === 'true' && env.SHOPIFY_BRIDGE_WRITES_ENABLED === 'true' && env.SHOPIFY_CONTENT_SYNC_ENABLED === 'true' && runtime.config.enabled === true && runtime.config.writesEnabled === true, 'Public page adoption requires all content write flags');
}
async function request(runtime, document, variables, options) {
  const response = await runtime.client.request(document, variables, options);
  requireValue(!response?.errors?.length, 'Public page API requires review');
  const data = response?.data || response;
  requireValue(plain(data), 'Public page API returned incomplete data');
  return data;
}
async function remotePage(runtime, handle) {
  let after = null; const found = [];
  for (let count = 0; count < 3; count++) {
    const result = (await request(runtime, ADOPTION_GRAPHQL.pages, { query: `handle:${handle}`, after })).pages;
    requireValue(Array.isArray(result?.nodes) && result.nodes.length <= 100 && plain(result.pageInfo) && typeof result.pageInfo.hasNextPage === 'boolean', 'Public page connection is incomplete');
    found.push(...result.nodes.filter(row => row.handle === handle));
    requireValue(found.length <= 1, 'Public Shopify page handle is ambiguous');
    if (!result.pageInfo.hasNextPage) {
      requireValue(found.length === 1, 'An existing public Shopify page must be explicitly selected');
      const row = found[0];
      requireValue(PAGE.test(row.id || '') && typeof row.isPublished === 'boolean' && (row.templateSuffix === null || typeof row.templateSuffix === 'string') && (row.owner === null || plain(row.owner) && typeof row.owner.value === 'string'), 'Public Shopify page identity is incomplete');
      return { id: row.id, handle: text(row.handle, 'handle', 100), title: text(row.title, 'title'), body: safeBody(row.body), templateSuffix: row.templateSuffix, isPublished: row.isPublished, owner: row.owner === null ? null : row.owner.value };
    }
    requireValue(typeof result.pageInfo.endCursor === 'string' && result.pageInfo.endCursor && result.pageInfo.endCursor !== after, 'Public page pagination did not advance');
    after = result.pageInfo.endCursor;
  }
  throw new Error('Public page read exceeded its bounded selection');
}
async function sourcePages(runtime, selection) {
  const result = await runtime.pool.query(`SELECT p.uuid,d.url_key,d.name,d.content FROM cms_page p
    JOIN cms_page_description d ON d.cms_page_description_cms_page_id=p.cms_page_id
    WHERE p.status=TRUE AND d.url_key=ANY($1::text[]) ORDER BY d.url_key LIMIT 3`, [selection]);
  requireValue(Array.isArray(result.rows) && result.rows.length === selection.length && new Set(result.rows.map(row => row.url_key)).size === selection.length, 'Every selected native public page must be active and unambiguous');
  return selection.map(handle => {
    const row = result.rows.find(row => row.url_key === handle);
    requireValue(row && UUID.test(row.uuid || ''), 'Native public page UUID must be preserved');
    const title = text(row.name, 'native title');
    requireValue(typeof row.content === 'string' && Buffer.byteLength(row.content) <= 256 * 1024, 'Native public page body must be bounded text');
    const body = normalizePublicContent(row.content);
    const sourceKey = buildContentPlan({ pages: [{ sourceUuid: row.uuid, handle, title, bodyHtml: body }] }).pages[0].sourceKey;
    return { uuid: row.uuid, sourceKey, handle, title, body, rawContentSha256: adoptionDigest(row.content) };
  });
}
function mappingFits(mapping, remote) {
  requireValue(mapping === null || plain(mapping) && mapping.id === remote.id && mapping.handle === remote.handle, 'Existing private page mapping identity differs');
}
function sameRemoteFields(left, right) {
  const { owner: _leftOwner, ...leftFields } = left; const { owner: _rightOwner, ...rightFields } = right;
  return adoptionDigest(leftFields) === adoptionDigest(rightFields);
}
function assertIntent(intent, { shop, page, planSha256, allowComplete = true }) {
  if (!intent) return;
  requireValue(intent.kind === 'public-page-adoption' && intent.shop === shop && intent.pageId === page.remote.id && intent.sourceKey === page.source.sourceKey && intent.ownerValue === page.ownerValue && ['prepared', 'in-flight', 'unknown', 'review', 'complete', 'rejected'].includes(intent.status), 'Existing adoption intent identity differs');
  requireValue(intent.planSha256 === planSha256 || allowComplete && intent.status === 'complete' && page.remote.owner === page.ownerValue, 'An earlier unresolved page adoption must be reconciled using its original frozen plan');
}
async function inspect(runtime, env, selection, profileProvider) {
  requireValue((await request(runtime, PREPARATION_READ.shop, {})).shop?.myshopifyDomain === runtime.config.shop, 'Shopify store identity differs');
  const profileSha256 = adoptionDigest(validatePublicMerchantProfile(await profileProvider({ env })));
  const native = await sourcePages(runtime, selection);
  const pages = [];
  for (const source of native) {
    const remote = await remotePage(runtime, source.handle); const expectedOwner = ownerValue(source.sourceKey);
    requireValue(remote.owner === null || remote.owner === expectedOwner, 'Public page has a conflicting bridge owner');
    const mapping = await runtime.repositories.mappings.get(source.sourceKey) || null; mappingFits(mapping, remote);
    pages.push({ source, remote, ownerValue: expectedOwner, mapping, mappingSha256: adoptionDigest(mapping) });
  }
  return { profileSha256, pages };
}

export function validatePublicPageAdoptionPlan(plan, reviewedSha256) {
  requireValue(plain(plan) && Object.keys(plan).every(key => ['schemaVersion', 'shop', 'capturedAt', 'handles', 'profileSha256', 'pages', 'dryRun', 'pageWrites', 'planSha256'].includes(key)), 'Public page adoption plan contains unsupported fields');
  const { planSha256, ...body } = plan;
  requireValue(plan.schemaVersion === 1 && plan.dryRun === true && plan.pageWrites === false && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(plan.shop || '') && SHA.test(plan.profileSha256 || '') && SHA.test(planSha256 || '') && adoptionDigest(body) === planSha256 && Number.isFinite(Date.parse(plan.capturedAt)), 'Saved public page adoption plan hash differs');
  requireValue(!reviewedSha256 || SHA.test(reviewedSha256) && reviewedSha256 === planSha256, 'Exact reviewed public page adoption hash is required');
  const selection = handles(plan.handles);
  requireValue(adoptionDigest(selection) === adoptionDigest(plan.handles) && Array.isArray(plan.pages) && plan.pages.length === selection.length, 'Saved public page selection differs');
  for (let index = 0; index < plan.pages.length; index++) {
    const page = plan.pages[index]; const source = page?.source; const remote = page?.remote;
    requireValue(plain(page) && Object.keys(page).every(key => ['source', 'remote', 'ownerValue', 'mapping', 'mappingSha256'].includes(key)) && plain(source) && Object.keys(source).every(key => ['uuid', 'sourceKey', 'handle', 'title', 'body', 'rawContentSha256'].includes(key)) && plain(remote) && Object.keys(remote).every(key => ['id', 'handle', 'title', 'body', 'templateSuffix', 'isPublished', 'owner'].includes(key)), 'Saved public page fields differ');
    requireValue(UUID.test(source.uuid || '') && source.handle === selection[index] && remote.handle === source.handle && PAGE.test(remote.id || '') && SHA.test(source.rawContentSha256 || '') && source.sourceKey === `page:${source.uuid}` && page.ownerValue === ownerValue(source.sourceKey) && (remote.owner === null || remote.owner === page.ownerValue) && typeof remote.isPublished === 'boolean' && (remote.templateSuffix === null || typeof remote.templateSuffix === 'string'), 'Saved public page association differs');
    text(source.title, 'native title'); text(remote.title, 'title'); safeBody(source.body); safeBody(remote.body);
    mappingFits(page.mapping, remote); requireValue(page.mappingSha256 === adoptionDigest(page.mapping), 'Saved public page mapping differs');
  }
  requireValue(new Set(plan.pages.map(page => page.source.uuid)).size === selection.length && new Set(plan.pages.map(page => page.remote.id)).size === selection.length, 'Public page identities are ambiguous');
  return plan;
}

export async function preparePublicPageAdoption({ runtime, env = process.env, selectedHandles, profileProvider = loadPublicMerchantProfile, now = () => new Date() }) {
  const store = validateRuntime(runtime); const selection = handles(selectedHandles);
  const work = async () => {
    const current = await inspect(runtime, env, selection, profileProvider);
    for (const page of current.pages) {
      const intent = await store.getOperation(intentKey(runtime.config.shop, page.remote.id));
      assertIntent(intent, { shop: runtime.config.shop, page, planSha256: null });
    }
    const body = { schemaVersion: 1, shop: runtime.config.shop, capturedAt: now().toISOString(), handles: selection, ...current, dryRun: true, pageWrites: false };
    return validatePublicPageAdoptionPlan({ ...body, planSha256: adoptionDigest(body) });
  };
  return store.withLock(`content-sync:${runtime.config.shop}`, work);
}

export async function applyPublicPageAdoption({ runtime, env = process.env, plan, reviewedSha256, profileProvider = loadPublicMerchantProfile, now = () => new Date() }) {
  const store = validateRuntime(runtime); assertWrites(runtime, env);
  requireValue(SHA.test(reviewedSha256 || ''), 'Exact reviewed public page adoption hash is required');
  validatePublicPageAdoptionPlan(plan, reviewedSha256); requireValue(plan.shop === runtime.config.shop, 'Saved public page store identity differs');
  return store.withLock(`content-sync:${runtime.config.shop}`, async () => {
    const key = operationKey(plan.shop, plan.planSha256); let journal = await store.getOperation(key);
    const frozenMetafields = plan.pages.filter(page => page.remote.owner === null).map(page => ({ ownerId: page.remote.id, namespace: 'shusha_bridge', key: 'source_key', type: 'single_line_text_field', value: page.ownerValue, compareDigest: null }));
    if (journal) requireValue(journal.kind === 'public-page-adoption' && journal.shop === plan.shop && journal.planSha256 === plan.planSha256 && ['prepared', 'in-flight', 'unknown', 'review', 'complete', 'rejected'].includes(journal.status) && journal.requestSha256 === adoptionDigest(frozenMetafields) && adoptionDigest(journal.metafields) === adoptionDigest(frozenMetafields), 'Adoption journal identity differs');
    const inspectAndValidate = async () => {
      const current = await inspect(runtime, env, plan.handles, profileProvider);
      requireValue(current.profileSha256 === plan.profileSha256, 'Shared public profile changed; review a new plan');
      for (let index = 0; index < plan.pages.length; index++) {
        const frozen = plan.pages[index]; const actual = current.pages[index];
        requireValue(adoptionDigest(actual.source) === adoptionDigest(frozen.source) && sameRemoteFields(actual.remote, frozen.remote), 'Native or Shopify public page changed; review a new plan');
        const intent = await store.getOperation(intentKey(plan.shop, actual.remote.id));
        assertIntent(intent, { shop: plan.shop, page: actual, planSha256: plan.planSha256 });
        const ourProgress = journal && ['in-flight', 'unknown', 'review', 'complete'].includes(journal.status);
        requireValue(actual.remote.owner === frozen.remote.owner || ourProgress && actual.remote.owner === frozen.ownerValue, 'Public page owner changed outside this reviewed adoption');
        const recoveredMapping = journal && actual.mapping?.adoptionPlanSha256 === plan.planSha256 && actual.mapping.id === frozen.remote.id && actual.mapping.handle === frozen.remote.handle;
        requireValue(actual.mappingSha256 === frozen.mappingSha256 || recoveredMapping, 'Private page mapping changed; review a new plan');
      }
      return current;
    };
    let current = await inspectAndValidate();
    const metafields = current.pages.filter(page => page.remote.owner === null).map(page => ({ ownerId: page.remote.id, namespace: 'shusha_bridge', key: 'source_key', type: 'single_line_text_field', value: page.ownerValue, compareDigest: null }));
    const resumed = Boolean(journal);
    if (journal && ['in-flight', 'unknown', 'review', 'complete', 'rejected'].includes(journal.status) && metafields.length) throw new Error('Adoption outcome requires readback of the original intent; unknown writes are not replayed');
    if (!journal) {
      journal = { kind: 'public-page-adoption', shop: plan.shop, planSha256: plan.planSha256, metafields, requestSha256: adoptionDigest(metafields), status: 'prepared', startedAt: now().toISOString() };
      await store.saveOperation(key, journal);
    } else requireValue(journal.status !== 'prepared' || journal.requestSha256 === adoptionDigest(metafields), 'Prepared adoption request changed');
    const saveIntents = async status => {
      for (const page of plan.pages) await store.saveOperation(intentKey(plan.shop, page.remote.id), { kind: 'public-page-adoption', shop: plan.shop, sourceKey: page.source.sourceKey, pageId: page.remote.id, ownerValue: page.ownerValue, planSha256: plan.planSha256, batchOperationKey: key, status });
    };
    await saveIntents('prepared');
    let ownerWrites = 0;
    if (metafields.length) {
      journal = { ...journal, status: 'in-flight', attemptedAt: now().toISOString() }; await store.saveOperation(key, journal); await saveIntents('in-flight');
      try {
        const payload = (await request(runtime, ADOPTION_GRAPHQL.setOwner, { metafields }, { kind: 'mutation', safeRetry: false })).metafieldsSet;
        requireValue(payload && Array.isArray(payload.userErrors), 'Owner mutation outcome requires readback');
        if (payload.userErrors.length) {
          journal = { ...journal, status: 'rejected', lastError: 'owner-write-rejected' }; await store.saveOperation(key, journal); await saveIntents('rejected');
          throw new Error('Public page owner mutation was rejected; review the original intent');
        }
        ownerWrites = metafields.length;
      } catch (error) {
        if (journal.status === 'rejected') throw error;
        journal = { ...journal, status: 'unknown', lastError: 'owner-outcome-needs-readback' }; await store.saveOperation(key, journal); await saveIntents('unknown');
      }
    }
    try {
      current = await inspectAndValidate();
      requireValue(current.pages.every(page => page.remote.owner === page.ownerValue), 'Owner write is not yet confirmed by fresh readback');
    } catch {
      journal = { ...journal, status: 'review', lastError: 'current-public-page-readback-required' }; await store.saveOperation(key, journal); await saveIntents('review');
      throw new Error('Adoption requires unchanged current public page and exact owner readback before any mapping is saved');
    }
    for (const page of current.pages) await store.put(page.source.sourceKey, { ...(page.mapping || {}), id: page.remote.id, handle: page.remote.handle, adoptionPlanSha256: plan.planSha256 });
    journal = { ...journal, status: 'complete', completedAt: now().toISOString() }; await store.saveOperation(key, journal); await saveIntents('complete');
    return { status: 'public-page-adoption-complete', planSha256: plan.planSha256, pages: current.pages.length, ownerWrites, resumed, pageContentWrites: false, publicationWrites: false };
  });
}

async function privateFile(root, filename, createParent = false) {
  const base = path.resolve(root); const allowed = path.join(base, 'shopify', 'adoption'); const target = path.resolve(filename);
  requireValue(target.startsWith(allowed + path.sep) && target.endsWith('.private.json'), 'Adoption plans must stay under private Shopify adoption data');
  // Check from the filesystem root, not just PRIVATE_DATA_DIR: a symlink above
  // that directory must be rejected before creating any external nested data.
  // Create each missing component only after all preceding ancestors pass.
  let ancestor = path.parse(base).root;
  const rootInfo = await fs.lstat(ancestor);
  requireValue(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Adoption paths cannot traverse symlinks');
  for (const part of path.relative(ancestor, path.dirname(target)).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    let info;
    try { info = await fs.lstat(ancestor); }
    catch (error) {
      if (error.code !== 'ENOENT' || !createParent) throw error;
      await fs.mkdir(ancestor, { mode: 0o700 }).catch(failure => { if (failure.code !== 'EEXIST') throw failure; });
      info = await fs.lstat(ancestor);
    }
    requireValue(info.isDirectory() && !info.isSymbolicLink(), 'Adoption paths cannot traverse symlinks');
  }
  return target;
}
async function readPlan(root, filename) {
  const target = await privateFile(root, filename); const info = await fs.lstat(target);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024, 'Adoption reads only bounded private plan files');
  return validatePublicPageAdoptionPlan(JSON.parse(await fs.readFile(target, 'utf8')));
}
async function writePlan(root, filename, plan) {
  const target = await privateFile(root, filename, true); let file;
  try { file = await fs.open(target, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST' || adoptionDigest(await readPlan(root, target)) !== adoptionDigest(plan)) throw error; return target; }
  try { await file.writeFile(`${JSON.stringify(plan, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  return target;
}

export async function adoptPublicPages({ env = process.env, runtime = null, selectedHandles, planFile, reviewedSha256, apply = false, profileProvider = loadPublicMerchantProfile, now = () => new Date() } = {}) {
  requireValue(!apply || planFile && reviewedSha256 && selectedHandles == null, 'Apply requires the original plan and reviewed hash; handles cannot replace it');
  requireValue(apply || selectedHandles != null && reviewedSha256 == null, 'Dry run requires explicit about/contact handles');
  const ownsRuntime = !runtime; const root = path.resolve(env.PRIVATE_DATA_DIR || path.join(process.cwd(), 'data'));
  if (!runtime) { const { bridgeRuntime } = await import('../../extensions/shopify-bridge/src/services/runtime.js'); runtime = bridgeRuntime(); }
  try {
    if (apply) return applyPublicPageAdoption({ runtime, env, plan: await readPlan(root, planFile), reviewedSha256, profileProvider, now });
    const plan = await preparePublicPageAdoption({ runtime, env, selectedHandles, profileProvider, now });
    const filename = await writePlan(root, planFile || path.join(root, 'shopify', 'adoption', `${plan.planSha256}.private.json`), plan);
    return { status: 'private-public-page-adoption-prepared', privatePlan: filename, planSha256: plan.planSha256, pages: plan.pages.length, dryRun: true, remoteWrites: false };
  } finally { if (ownsRuntime) await runtime.pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help')) {
      console.log('Usage: node scripts/shopify/adopt-public-pages.mjs --handles about,contact [--plan PRIVATE_DATA_DIR/shopify/adoption/NAME.private.json]\nApply only after merchant review: --apply --plan ORIGINAL_PRIVATE_PLAN --reviewed-sha256 EXACT_SHA256\nDefault dry run selects only the named existing native/Shopify public pages. Apply needs all existing bridge/content write flags and a current unchanged profile. It writes owner metadata/private mappings only. Unknown writes are read back, never replayed.');
    } else {
      const options = {}; const flags = { '--handles': 'selectedHandles', '--plan': 'planFile', '--reviewed-sha256': 'reviewedSha256' };
      for (let index = 2; index < process.argv.length; index++) {
        const flag = process.argv[index];
        if (flag === '--apply' && options.apply == null) options.apply = true;
        else if (flags[flag] && options[flags[flag]] == null && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) options[flags[flag]] = flag === '--handles' ? process.argv[++index].split(',') : process.argv[++index];
        else throw new Error('Unsupported adoption arguments');
      }
      console.log(JSON.stringify(await adoptPublicPages(options)));
    }
  } catch {
    console.error(JSON.stringify({ status: 'failed', code: 'PUBLIC_PAGE_ADOPTION_REVIEW', message: 'Review the original frozen private plan, current public pages/profile and owner intent before proceeding' })); process.exitCode = 1;
  }
}
