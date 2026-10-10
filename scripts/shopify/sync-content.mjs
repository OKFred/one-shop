import { createHash } from 'node:crypto';
import { cp, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';

// The caller supplies the authenticated 2026-10 client and private durable store.
// Importing this module never reads credentials or contacts Shopify.
const ownerField = 'owner: metafield(namespace: "shusha_bridge", key: "source_key") { value }';
const pageFields = `id handle title body isPublished ${ownerField}`;
const collectionFields = `id handle title descriptionHtml sortOrder ${ownerField} sources { __typename id title }`;
const menuFields = 'id handle title items { id title type url resourceId items { id title type url resourceId items { id title type url resourceId } } }';
export const CONTENT_GRAPHQL = Object.freeze({
  pages: `query ShushaContentPages($query: String!, $after: String) { pages(first: 100, after: $after, query: $query) { nodes { ${pageFields} } pageInfo { hasNextPage endCursor } } }`,
  collections: `query ShushaContentCollections($query: String!, $after: String) { collections(first: 100, after: $after, query: $query) { nodes { ${collectionFields} } pageInfo { hasNextPage endCursor } } }`,
  menus: `query ShushaContentMenus($after: String) { menus(first: 100, after: $after) { nodes { ${menuFields} } pageInfo { hasNextPage endCursor } } }`,
  redirects: 'query ShushaContentRedirects($query: String!, $after: String) { urlRedirects(first: 100, after: $after, query: $query) { nodes { id path target } pageInfo { hasNextPage endCursor } } }',
  pageCreate: `mutation ShushaPageCreate($page: PageCreateInput!) { pageCreate(page: $page) { page { ${pageFields} } userErrors { field message } } }`,
  pageUpdate: `mutation ShushaPageUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { ${pageFields} } userErrors { field message } } }`,
  collectionCreate: `mutation ShushaCollectionCreate($collection: CollectionCreateInput!) { collectionCreate(collection: $collection) { collection { ${collectionFields} } userErrors { field message } } }`,
  collectionUpdate: `mutation ShushaCollectionUpdate($collection: CollectionUpdateInput!) { collectionUpdate(collection: $collection) { collection { ${collectionFields} } job { id done } userErrors { field message } } }`,
  collectionProducts: 'query ShushaCollectionProducts($id: ID!, $after: String) { collection(id: $id) { products(first: 250, after: $after, sortKey: COLLECTION_DEFAULT) { nodes { id } pageInfo { hasNextPage endCursor } } } }',
  sourceSelections: 'query ShushaSourceSelections($id: ID!, $after: String) { node(id: $id) { ... on CollectionConditionsSource { inclusion { selections(first: 250, after: $after) { nodes { product { id } } pageInfo { hasNextPage endCursor } } } } } }',
  reorder: 'mutation ShushaCollectionReorder($id: ID!, $moves: [MoveInput!]!) { collectionReorderProducts(id: $id, moves: $moves) { job { id done } userErrors { field message } } }',
  job: 'query ShushaContentJob($id: ID!) { job(id: $id) { id done } }',
  menuCreate: `mutation ShushaMenuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) { menuCreate(title: $title, handle: $handle, items: $items) { menu { ${menuFields} } userErrors { field message } } }`,
  menuUpdate: `mutation ShushaMenuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) { menuUpdate(id: $id, title: $title, items: $items) { menu { ${menuFields} } userErrors { field message } } }`,
  redirectCreate: 'mutation ShushaRedirectCreate($urlRedirect: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $urlRedirect) { urlRedirect { id path target } userErrors { field message } } }',
  redirectUpdate: 'mutation ShushaRedirectUpdate($id: ID!, $urlRedirect: UrlRedirectInput!) { urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) { urlRedirect { id path target } userErrors { field message } } }'
});

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const owner = sourceKey => [{ namespace: 'shusha_bridge', key: 'source_key', type: 'single_line_text_field', value: hash(sourceKey) }];
function text(value, name, limit = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function handle(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 100) throw new Error('Invalid content handle');
  return value;
}
function internalPath(value) {
  if (typeof value !== 'string' || !/^\/(?!\/)[a-z0-9/_-]*$/i.test(value) || value.includes('..') || value.length > 255) throw new Error('Invalid internal path');
  return value;
}

export function sanitizeContentHtml(value = '') {
  if (typeof value !== 'string' || value.length > 500_000) throw new Error('Invalid CMS HTML');
  return sanitizeHtml(value, {
    allowedTags: ['p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    allowedAttributes: { a: ['href'], th: ['scope'], td: ['colspan', 'rowspan'] },
    allowedSchemes: ['https', 'mailto', 'tel'], allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attributes) => {
        const href = attributes.href || '';
        // Images and widget styling belong to native media/theme settings.
        const safe = !/[\\\p{Cc}\p{Cf}]/u.test(href) && !/%(?:5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(href) && (/^\/(?!\/)/.test(href) || /^https:\/\//i.test(href) || /^(mailto:|tel:)/i.test(href));
        return { tagName: 'a', attribs: safe ? { href } : {} };
      }
    }
  });
}

function ensureUnique(values, key) {
  const seen = new Set();
  for (const value of values) { const id = key(value); if (seen.has(id)) throw new Error('Duplicate content identity'); seen.add(id); }
}

export function buildContentPlan(snapshot, { publishPages = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('A content snapshot is required');
  const published = (snapshot.products || []).filter(p => p.status === 'PUBLISHED');
  ensureUnique(published, p => text(p.sourceUuid, 'published product identity'));
  const byProduct = new Map(published.map(p => {
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(p.shopifyGid)) throw new Error('Published product must have a verified Shopify mapping');
    if (!/^l\d{4,}$/i.test(p.handle)) throw new Error('Published product handle must preserve its style code');
    if (!Number.isFinite(Date.parse(p.publishedAt))) throw new Error('Published product requires its original publication time');
    return [p.sourceUuid, { ...p, handle: p.handle.toLowerCase() }];
  }));
  ensureUnique([...byProduct.values()], p => p.handle);
  const pages = (snapshot.pages || []).map(p => ({ sourceKey: `page:${text(p.sourceUuid, 'page identity')}`, handle: handle(p.handle), title: text(p.title, 'page title'), body: sanitizeContentHtml(p.bodyHtml), isPublished: publishPages === true }));
  const collections = (snapshot.collections || []).map(c => {
    const products = (c.productUuids || []).map(uuid => byProduct.get(uuid)).filter(Boolean).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.handle.localeCompare(b.handle));
    ensureUnique(products, p => p.shopifyGid);
    return { sourceKey: `collection:${text(c.sourceUuid, 'collection identity')}`, handle: handle(c.handle), title: text(c.title, 'collection title'), descriptionHtml: sanitizeContentHtml(c.descriptionHtml), productIds: products.map(p => p.shopifyGid) };
  });
  ensureUnique(pages, p => p.handle); ensureUnique(collections, c => c.handle);
  ensureUnique(pages, p => p.sourceKey); ensureUnique(collections, c => c.sourceKey);
  const resources = new Map([...pages.map(p => [`page:${p.handle}`, `/pages/${p.handle}`]), ...collections.map(c => [`collection:${c.handle}`, `/collections/${c.handle}`])]);
  function item(input, depth = 0) {
    if (depth > 2) throw new Error('Navigation cannot exceed three levels');
    const title = text(input.title, 'navigation title');
    let url;
    if (input.type === 'page' || input.type === 'collection') {
      url = resources.get(`${input.type}:${handle(input.handle)}`);
      if (!url) throw new Error('Navigation refers to an unexported resource');
    } else if (input.type === 'url') url = internalPath(input.url);
    else throw new Error('Unsupported navigation item');
    return { title, type: 'HTTP', url, items: (input.items || []).map(child => item(child, depth + 1)) };
  }
  const menus = (snapshot.menus || []).map(m => {
    if (!/^shusha-/.test(m.handle || '')) throw new Error('Only merchant-owned navigation can be synchronized');
    return { sourceKey: `menu:${handle(m.handle)}`, handle: m.handle, title: text(m.title, 'menu title'), items: (m.items || []).map(i => item(i)) };
  });
  ensureUnique(menus, m => m.handle);
  const redirects = [
    ...pages.map(p => ({ path: `/${p.handle}`, target: `/pages/${p.handle}` })),
    ...collections.map(c => ({ path: `/${c.handle}`, target: `/collections/${c.handle}` })),
    ...published.filter(p => p.categoryHandle).map(p => ({ path: `/${handle(p.categoryHandle)}/${p.handle.toLowerCase()}`, target: `/products/${p.handle.toLowerCase()}` })),
    ...(snapshot.redirects || []).map(r => ({ path: internalPath(r.path), target: internalPath(r.target) }))
  ];
  const targets = new Set([...resources.values(), ...published.map(p => `/products/${p.handle.toLowerCase()}`)]);
  const uniqueRedirects = new Map();
  for (const redirect of redirects) {
    if (!targets.has(redirect.target) || redirect.path === redirect.target) throw new Error('Redirect target must be an exported native resource');
    if (/^\/(products|collections|pages|cart|checkout|account)(\/|$)/.test(redirect.path)) throw new Error('Native routes cannot be redirected');
    if (uniqueRedirects.has(redirect.path) && uniqueRedirects.get(redirect.path).target !== redirect.target) throw new Error('Conflicting redirect');
    uniqueRedirects.set(redirect.path, redirect);
  }
  return { pages, collections, menus, redirects: [...uniqueRedirects.values()] };
}

function withoutItemIds(items) { return items.map(({ title, type, url, items: children = [] }) => ({ title, type, url, items: withoutItemIds(children) })); }
function withExistingItemIds(items, existing = []) {
  const used = new Set();
  return items.map(item => {
    const same = existing.find(e => !used.has(e.id) && e.url === item.url && e.type === item.type);
    if (same) used.add(same.id);
    return { ...item, ...(same ? { id: same.id } : {}), items: withExistingItemIds(item.items, same?.items) };
  });
}

export function computeCollectionMoves(currentIds, desiredIds) {
  const current = [...currentIds]; const moves = [];
  for (let index = 0; index < desiredIds.length; index++) {
    const position = current.indexOf(desiredIds[index]);
    if (position < 0) throw new Error('Collection membership has not finished updating');
    if (position !== index) { moves.push({ id: desiredIds[index], newPosition: String(index) }); current.splice(position, 1); current.splice(index, 0, desiredIds[index]); }
  }
  return moves;
}

export function createContentSync({ graphql, stateStore, waitForJob } = {}) {
  if (typeof graphql !== 'function' || !stateStore?.get || !stateStore?.put || !stateStore?.withLock) throw new Error('Authenticated GraphQL and a private, exclusively locked durable state store are required');
  async function request(operation, variables) {
    const response = await graphql(CONTENT_GRAPHQL[operation], variables);
    if (response?.errors?.length) throw new Error(`Shopify content GraphQL failed: ${operation}`);
    const data = response?.data || response;
    if (!data || typeof data !== 'object') throw new Error(`Invalid Shopify response: ${operation}`);
    return data;
  }
  async function connection(operation, variables, select) {
    let after = null; const nodes = [];
    for (let count = 0; count < 100; count++) {
      const result = select(await request(operation, { ...variables, after }));
      if (!result?.nodes || !result.pageInfo) throw new Error('Incomplete content connection');
      nodes.push(...result.nodes);
      if (!result.pageInfo.hasNextPage) return nodes;
      if (!result.pageInfo.endCursor || result.pageInfo.endCursor === after) throw new Error('Content pagination did not advance');
      after = result.pageInfo.endCursor;
    }
    throw new Error('Content pagination limit reached');
  }
  async function mutation(operation, variables, payloadName) {
    const payload = (await request(operation, variables))[payloadName];
    if (!payload || !Array.isArray(payload.userErrors) || payload.userErrors.length) throw new Error(`Shopify rejected content mutation: ${operation}`);
    if (payload.job && !payload.job.done) {
      if (!waitForJob || !(await waitForJob(payload.job.id, id => request('job', { id })))) throw new Error('Content job is pending; retry with readback before continuing');
    }
    return payload;
  }
  function assertOwner(remote, desired, previous) {
    if (remote && remote.owner?.value !== hash(desired.sourceKey)) throw new Error('Content handle belongs to an unmanaged resource');
    if (previous?.id && remote?.id !== previous.id) throw new Error('Content identity changed; investigate before synchronizing');
  }
  return {
    async sync(snapshot, { dryRun = true, publishPages = false } = {}) {
      const plan = buildContentPlan(snapshot, { publishPages });
      return stateStore.withLock(async () => {
        const report = { dryRun, pages: 0, collections: 0, menus: 0, redirects: 0, unchanged: 0 };
        for (const desired of plan.pages) {
          const matches = (await connection('pages', { query: `handle:${desired.handle}` }, d => d.pages)).filter(p => p.handle === desired.handle);
          if (matches.length > 1) throw new Error('Ambiguous page handle');
          let remote = matches[0]; const previous = await stateStore.get(desired.sourceKey); assertOwner(remote, desired, previous);
          const input = { handle: desired.handle, title: desired.title, body: desired.body, isPublished: desired.isPublished, metafields: owner(desired.sourceKey) };
          const equal = remote && ['handle', 'title', 'body', 'isPublished'].every(key => remote[key] === input[key]);
          if (equal) report.unchanged++;
          else { report.pages++; if (!dryRun) remote = (await mutation(remote ? 'pageUpdate' : 'pageCreate', remote ? { id: remote.id, page: input } : { page: input }, remote ? 'pageUpdate' : 'pageCreate')).page; }
          if (!dryRun && remote) { assertOwner(remote, desired); await stateStore.put(desired.sourceKey, { id: remote.id, handle: desired.handle, digest: hash(input) }); }
        }
        for (const desired of plan.collections) {
          const matches = (await connection('collections', { query: `handle:${desired.handle}` }, d => d.collections)).filter(c => c.handle === desired.handle);
          if (matches.length > 1) throw new Error('Ambiguous collection handle');
          let remote = matches[0]; const previous = await stateStore.get(desired.sourceKey); assertOwner(remote, desired, previous);
          const input = { handle: desired.handle, title: desired.title, descriptionHtml: desired.descriptionHtml, sortOrder: 'MANUAL', metafields: owner(desired.sourceKey) };
          if (!remote) {
            report.collections++;
            if (dryRun) continue;
            remote = (await mutation('collectionCreate', { collection: { ...input, sources: [{ source: { title: 'SHUSHA bridge', inclusion: { selections: desired.productIds.slice(0, 250).map(productId => ({ productId })) } } }] } }, 'collectionCreate')).collection;
            assertOwner(remote, desired); await stateStore.put(desired.sourceKey, { id: remote.id, handle: desired.handle });
          }
          const sources = remote.sources.filter(s => s.title === 'SHUSHA bridge' && s.__typename === 'CollectionConditionsSource');
          if (sources.length !== 1 || remote.sources.length !== 1) throw new Error('Collection sources changed; do not overwrite merchant membership');
          const selected = (await connection('sourceSelections', { id: sources[0].id }, d => d.node?.inclusion?.selections)).map(s => s.product.id);
          const add = desired.productIds.filter(id => !selected.includes(id));
          const remove = selected.filter(id => !desired.productIds.includes(id));
          const fieldsChanged = ['handle', 'title', 'descriptionHtml', 'sortOrder'].some(key => remote[key] !== input[key]);
          if (fieldsChanged || add.length || remove.length) {
            report.collections++;
            if (!dryRun) {
              for (let offset = 0; offset < Math.max(add.length, remove.length, 1); offset += 250) {
                await mutation('collectionUpdate', { collection: { id: remote.id, ...input, ...(add.length || remove.length ? { sourcesToUpdate: [{ condition: { id: sources[0].id, inclusion: { selectionsToAdd: add.slice(offset, offset + 250).map(productId => ({ productId })), selectionsToRemove: remove.slice(offset, offset + 250).map(productId => ({ productId })) } } }] } : {}) } }, 'collectionUpdate');
              }
            }
          }
          if (!dryRun) {
            const current = (await connection('collectionProducts', { id: remote.id }, d => d.collection?.products)).map(p => p.id);
            if (current.length !== desired.productIds.length) throw new Error('Collection membership readback differs');
            const moves = computeCollectionMoves(current, desired.productIds);
            for (let offset = 0; offset < moves.length; offset += 250) await mutation('reorder', { id: remote.id, moves: moves.slice(offset, offset + 250) }, 'collectionReorderProducts');
            const actual = (await connection('collectionProducts', { id: remote.id }, d => d.collection?.products)).map(p => p.id);
            if (JSON.stringify(actual) !== JSON.stringify(desired.productIds)) throw new Error('Collection order readback differs');
            await stateStore.put(desired.sourceKey, { id: remote.id, handle: desired.handle, digest: hash({ ...input, productIds: desired.productIds }) });
          }
        }
        const remoteMenus = plan.menus.length ? await connection('menus', {}, d => d.menus) : [];
        for (const desired of plan.menus) {
          const matches = remoteMenus.filter(m => m.handle === desired.handle);
          if (matches.length > 1) throw new Error('Ambiguous navigation handle');
          let remote = matches[0]; const previous = await stateStore.get(desired.sourceKey);
          const equal = remote && remote.title === desired.title && JSON.stringify(withoutItemIds(remote.items)) === JSON.stringify(desired.items);
          if (remote && (!previous?.id || previous.id !== remote.id) && !equal) throw new Error('Navigation handle belongs to an unmanaged resource');
          if (equal) report.unchanged++;
          else { report.menus++; if (!dryRun) remote = (await mutation(remote ? 'menuUpdate' : 'menuCreate', remote ? { id: remote.id, title: desired.title, items: withExistingItemIds(desired.items, remote.items) } : { title: desired.title, handle: desired.handle, items: desired.items }, remote ? 'menuUpdate' : 'menuCreate')).menu; }
          if (!dryRun && remote) await stateStore.put(desired.sourceKey, { id: remote.id, handle: desired.handle, digest: hash(desired) });
        }
        for (const desired of plan.redirects) {
          const matches = (await connection('redirects', { query: `path:${desired.path}` }, d => d.urlRedirects)).filter(r => r.path === desired.path);
          if (matches.length > 1) throw new Error('Ambiguous redirect path');
          let remote = matches[0]; const sourceKey = `redirect:${desired.path}`; const previous = await stateStore.get(sourceKey);
          if (remote?.target === desired.target) report.unchanged++;
          else {
            if (remote && previous?.id !== remote.id) throw new Error('Redirect path belongs to an unmanaged resource');
            report.redirects++;
            if (!dryRun) remote = (await mutation(remote ? 'redirectUpdate' : 'redirectCreate', remote ? { id: remote.id, urlRedirect: desired } : { urlRedirect: desired }, remote ? 'urlRedirectUpdate' : 'urlRedirectCreate')).urlRedirect;
          }
          if (!dryRun && remote) await stateStore.put(sourceKey, { id: remote.id, path: desired.path, target: desired.target });
        }
        return report;
      });
    }
  };
}

// Generate a private copy of the checked-in theme. Merchant content must never
// be written into the vendored directory or a public path.
export async function writeMerchantThemeConfig({ themePath, outputPath, merchant }) {
  const source = await realpath(themePath);
  const destination = path.resolve(outputPath);
  if (destination === source || destination.startsWith(source + path.sep) || !destination.split(path.sep).some(part => ['private', 'private-data'].includes(part))) throw new Error('Theme output must be a separate private directory');
  const ancestor = await realpath(path.dirname(destination));
  if (!ancestor.split(path.sep).some(part => ['private', 'private-data'].includes(part))) throw new Error('Theme output must resolve inside a private directory');
  try { await lstat(destination); throw new Error('Private theme output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  const read = async file => JSON.parse(await readFile(path.join(destination, file), 'utf8'));
  const write = async (file, data) => writeFile(path.join(destination, file), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  const index = await read('templates/index.json'); const hero = merchant.hero || {};
  const fields = { eyebrow: 'eyebrow', heading: 'heading', primaryLabel: 'primary_label', secondaryLabel: 'secondary_label', noteLeft: 'note_left', noteRight: 'note_right' };
  for (const [input, output] of Object.entries(fields)) if (hero[input]) index.sections.hero.settings[output] = text(hero[input], `hero ${input}`, 400);
  if (hero.descriptionHtml) index.sections.hero.settings.description = sanitizeContentHtml(hero.descriptionHtml);
  for (const [input, output] of [['primaryLink', 'primary_link'], ['secondaryLink', 'secondary_link']]) if (hero[input]) index.sections.hero.settings[output] = internalPath(hero[input]);
  if (hero.image) {
    if (!/^shopify:\/\/shop_images\/[a-zA-Z0-9_.-]+$/.test(hero.image)) throw new Error('Hero image must be a verified uploaded Shopify image');
    index.sections.hero.settings.image = hero.image;
  }
  await write('templates/index.json', index);
  const footer = await read('sections/footer-group.json');
  if (merchant.footer?.descriptionHtml) footer.sections.footer.settings.description = sanitizeContentHtml(merchant.footer.descriptionHtml);
  await write('sections/footer-group.json', footer);
  const settings = await read('config/settings_data.json');
  for (const [input, output] of [['whatsappSriLanka', 'shusha_whatsapp_sri_lanka'], ['whatsappChina', 'shusha_whatsapp_china']]) {
    const value = merchant.support?.[input] || '';
    if (value && !/^https:\/\/wa\.me\/\d{7,15}$/.test(value)) throw new Error('Only a verified WhatsApp support link is allowed');
    settings.current[output] = value;
  }
  await write('config/settings_data.json', settings);
  return { path: destination, unpublishedOnly: true };
}
