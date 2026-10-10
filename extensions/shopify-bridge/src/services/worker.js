import { createHash, randomUUID } from 'node:crypto';
import { createShopifyClient } from './shopifyClient.js';
import { retailUsd, createCatalogFollower } from './catalog.js';
import { enqueue, processOutbox, withTransaction, releaseAdvisoryOwner } from './outbox.js';
import { hydrateShopifyOrder, ingestShopifyOrder, reconcileRecentOrders, auditCapacity } from './orders.js';
import { integer, openCapacity } from './inventory.js';

const COLLECTION_CATEGORIES = ['dresses', 'pants', 'tops'];
const COLLECTION_PRODUCT_READ = `query BridgeCollectionProducts($ids:[ID!]!,$publication:ID!){nodes(ids:$ids){
  ... on Product{id status publishedOnPublication(publicationId:$publication)
    metafield(namespace:"shusha_bridge",key:"source_uuid"){value}}
}}`;

/** Complete current membership, using native category identities and live owned publications. */
export async function loadPublishedCollectionSnapshot(runtime, env = process.env) {
  if (!/^gid:\/\/shopify\/Publication\/[0-9]+$/.test(env.SHOPIFY_PUBLICATION_ID || '')) throw new Error('Reviewed Shopify publication is required');
  const categories = (await runtime.pool.query(`SELECT c.category_id,c.uuid,d.url_key,d.name,d.description FROM category c
    JOIN category_description d ON d.category_description_category_id=c.category_id
    WHERE c.status=TRUE AND d.url_key=ANY($1::text[]) ORDER BY d.url_key`, [COLLECTION_CATEGORIES])).rows;
  if (categories.length !== COLLECTION_CATEGORIES.length || new Set(categories.map((row) => row.url_key)).size !== categories.length) {
    throw new Error('Canonical native category identities must be complete');
  }
  const styles = (await runtime.pool.query(`SELECT p.uuid,d.url_key,publication.created_at,
    publication.plan->>'category' AS category,m.record FROM shusha_material_publication publication
    JOIN product p ON p.sku=publication.anchor_sku
    JOIN product_description d ON d.product_description_product_id=p.product_id
    JOIN shusha_bridge_mapping m ON m.kind='product' AND m.source_key=p.uuid::text
    WHERE publication.status='complete' AND p.status=TRUE AND p.visibility=TRUE
    AND publication.plan->'review'->>'ready'='true'
    AND EXISTS(SELECT 1 FROM product_category pc JOIN category_description cd ON cd.category_description_category_id=pc.category_id
      WHERE pc.product_id=p.product_id AND cd.url_key=publication.plan->>'category')
    ORDER BY publication.created_at,p.uuid LIMIT 501`)).rows;
  if (styles.length > 500 || new Set(styles.map((style) => style.uuid)).size !== styles.length) throw new Error('Published collection snapshot exceeds its reviewed bound or is ambiguous');
  const published = new Map();
  for (let offset = 0; offset < styles.length; offset += 50) {
    const part = styles.slice(offset, offset + 50);
    if (part.some((style) => !/^gid:\/\/shopify\/Product\/[0-9]+$/.test(style.record.productGid || ''))) throw new Error('Every collection style needs its native Shopify mapping');
    const data = await runtime.client.request(COLLECTION_PRODUCT_READ, { ids: part.map((style) => style.record.productGid), publication: env.SHOPIFY_PUBLICATION_ID });
    if (!Array.isArray(data.nodes) || data.nodes.length !== part.length) throw new Error('Complete live publication readback is required');
    for (const style of part) {
      const product = data.nodes.find((node) => node?.id === style.record.productGid);
      if (!product || product.metafield?.value !== style.uuid) throw new Error('Collection product ownership changed');
      if (product.status === 'ACTIVE' && product.publishedOnPublication === true) published.set(style.uuid, style);
    }
  }
  const products = [...published.values()].map((style) => ({ sourceUuid: style.uuid, handle: style.url_key,
    shopifyGid: style.record.productGid, status: 'PUBLISHED', publishedAt: new Date(style.created_at).toISOString() }));
  const { safeDescription } = await import('./catalog.js');
  return { products, collections: categories.map((category) => ({ sourceUuid: category.uuid, handle: category.url_key,
    title: category.name, descriptionHtml: safeDescription(category.description),
    productUuids: [...published.values()].filter((style) => style.category === category.url_key).map((style) => style.uuid) })),
  pages: [], menus: [], redirects: [] };
}

/** Collection-only recovery is durable; no pages, navigation, theme or assets are rewritten. */
export async function followPublishedCollections(runtime, env = process.env, {
  snapshotProvider = null, synchronizerFactory = null, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!runtime.config.enabled || !runtime.config.writesEnabled || env.SHOPIFY_CONTENT_SYNC_ENABLED !== 'true' ||
      env.SHOPIFY_CATALOG_PUBLICATION_ENABLED !== 'true' || env.SHOPIFY_SHARED_CAPACITY_ENABLED !== 'true' ||
      env.SHOPIFY_PAYMENT_OPERATIONS_ENABLED !== 'true') return { status: 'disabled', collections: 0 };
  const store = runtime.repositories.mappings;
  return store.withLock(`content-sync:${runtime.config.shop}`, async () => {
    const snapshot = await (snapshotProvider || loadPublishedCollectionSnapshot)(runtime, env);
    if (!Array.isArray(snapshot.collections) || !Array.isArray(snapshot.products) || snapshot.pages?.length || snapshot.menus?.length || snapshot.redirects?.length) {
      throw new Error('Recurring content following is limited to current published collections');
    }
    const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const key = 'collection-follower'; const previous = await store.getOperation(key);
    if (previous?.status === 'complete' && previous.digest === digest) return { status: 'unchanged', collections: snapshot.collections.length };
    const intent = { digest, status: 'pending', startedAt: previous?.digest === digest ? previous.startedAt : new Date(now()).toISOString() };
    await store.saveOperation(key, intent);
    try {
      const createSync = synchronizerFactory || (await import('../../../../scripts/shopify/sync-content.mjs')).createContentSync;
      const sync = createSync({ graphql: (document, variables) => runtime.client.request(document, variables),
        stateStore: { get: store.get, put: store.put, withLock: async (work) => work() },
        waitForJob: async (id, readJob) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            if ((await readJob(id)).job?.done === true) return true;
            if (attempt < 2) await sleep(150);
          }
          return false;
        }
      });
      const report = await sync.sync(snapshot, { dryRun: false, publishPages: false });
      if (report.pages || report.menus) throw new Error('Collection follower exceeded its content boundary');
      await store.saveOperation(key, { ...intent, status: 'complete', completedAt: new Date(now()).toISOString() });
      return { status: 'completed', collections: snapshot.collections.length, changed: report.collections };
    } catch (error) {
      await store.saveOperation(key, { ...intent, lastError: 'collection-following-requires-readback' });
      throw error;
    }
  });
}

export async function resolveInventory(pool, sku, locationId) {
  if (!/^gid:\/\/shopify\/Location\/[0-9]+$/.test(locationId || '')) throw new Error('A reviewed Shopify inventory location is required');
  const rows = (await pool.query(`SELECT v->>'inventoryItemGid' AS item FROM shusha_bridge_mapping m,
    LATERAL jsonb_array_elements(m.record->'variants') v WHERE m.kind='product' AND v->>'sku'=$1`, [sku])).rows;
  if (rows.length !== 1 || !/^gid:\/\/shopify\/InventoryItem\/[0-9]+$/.test(rows[0].item || '')) {
    throw new Error('A unique mapped Shopify inventory item is required');
  }
  return { inventoryItemId: rows[0].item, locationId };
}

async function restockEvidence(pool, orderId) {
  const record = (await pool.query(`SELECT record FROM shusha_bridge_mapping WHERE kind='operation' AND source_key=$1`, [`order-restock:${orderId}`])).rows[0]?.record;
  return record?.status === 'complete' ? (record.restockEvidence || {}) : {};
}

export async function processInbox(pool, { client, tokens, expectedShop, limit = 20, ordersEnabled = true } = {}) {
  if (!client?.request || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid bounded inbox processor');
  const owner = await pool.connect();
  let lock;
  try { lock = (await owner.query("SELECT pg_try_advisory_lock(hashtext('shusha:bridge:inbox')) AS locked")).rows[0].locked; }
  catch (error) { owner.release(error); throw error; }
  if (!lock) { owner.release(); return { busy: true, processed: 0, failed: 0 }; }
  let processed = 0; let failed = 0; let deferred = 0; let uninstalled = false;
  try {
    const deliveries = (await pool.query(`SELECT delivery_id,shop,topic,payload FROM shusha_bridge_inbox
      WHERE state='pending' AND attempts<10 AND ($2::boolean OR topic='app/uninstalled')
      ORDER BY received_at,delivery_id LIMIT $1`, [limit, ordersEnabled])).rows;
    for (const delivery of deliveries) {
      try {
        if (delivery.topic === 'app/uninstalled') {
          if (!tokens?.revoke) throw new Error('Uninstallation token adapter is required');
          const shop = expectedShop || client.shop;
          // Shopify signs the body, not the topic header. A captured order
          // payload relabeled as uninstall must not delete installation tokens.
          const installation = (await pool.query("SELECT record FROM shusha_bridge_mapping WHERE kind='operation' AND source_key=$1", [`installation:${shop}`])).rows[0]?.record;
          const verifiedShopId = installation?.kind === 'installation' && installation.status === 'complete' && installation.shop === shop &&
            /^[0-9]+$/.test(installation.shopId || '') && installation.shopId === String(delivery.payload?.id);
          const domain = delivery.payload?.myshopify_domain;
          const correctIdentity = domain == null ? verifiedShopId : domain === shop;
          if (typeof shop !== 'string' || delivery.shop !== shop || !correctIdentity ||
              !/^[0-9]+$/.test(String(delivery.payload?.id ?? '')) || typeof delivery.payload?.name !== 'string' || !delivery.payload.name ||
              ['line_items','order_id','order_number','financial_status','refund_line_items'].some((key) => key in delivery.payload)) {
            throw new Error('Uninstallation needs its signed configured Shop identity');
          }
          await tokens.revoke();
          uninstalled = true;
        } else if (['orders/create', 'orders/updated', 'orders/cancelled', 'orders/paid', 'refunds/create', 'fulfillments/create', 'fulfillments/update'].includes(delivery.topic)) {
          const id = delivery.payload.order_id ?? delivery.payload.admin_graphql_api_id ?? delivery.payload.id;
          const order = await hydrateShopifyOrder(client, id);
          const result = await ingestShopifyOrder(pool, order, { restockEvidence: await restockEvidence(pool, order.id) });
          if (result.deferred) {
            await pool.query("UPDATE shusha_bridge_inbox SET last_error='trusted-cancellation-pending' WHERE delivery_id=$1", [delivery.delivery_id]);
            deferred += 1; continue;
          }
        } else throw new Error('Webhook topic needs a reviewed adapter');
        // Crash before this write safely replays the business-key protected ledger.
        await pool.query(`UPDATE shusha_bridge_inbox SET state='processed',processed_at=NOW(),last_error=NULL WHERE delivery_id=$1`, [delivery.delivery_id]);
        processed += 1;
      } catch (_) {
        await pool.query(`UPDATE shusha_bridge_inbox SET attempts=attempts+1,
          state=CASE WHEN attempts+1>=10 THEN 'attention' ELSE 'pending' END,last_error='inbox-processing-requires-review' WHERE delivery_id=$1`, [delivery.delivery_id]);
        failed += 1;
      }
    }
    return { processed, failed, deferred, uninstalled };
  } finally {
    await releaseAdvisoryOwner(owner, "SELECT pg_advisory_unlock(hashtext('shusha:bridge:inbox'))");
  }
}

/** Price changes only: never productSet, inventory, option replacement or image writes. */
export async function enqueuePriceChanges(pool) {
  const mappings = (await pool.query(`SELECT source_key,record FROM shusha_bridge_mapping WHERE kind='product' ORDER BY source_key`)).rows;
  let queued = 0;
  for (const mapping of mappings) {
    if (!Array.isArray(mapping.record.variants) || !mapping.record.variants.length) throw new Error('Mapped variants are required for price synchronization');
    const skus = mapping.record.variants.map((variant) => variant.sku);
    const native = (await pool.query('SELECT sku,price FROM product WHERE sku=ANY($1::text[]) ORDER BY sku', [skus])).rows;
    if (native.length !== skus.length) throw new Error('Every price SKU must still exist natively');
    const variants = native.map((row) => ({ id: mapping.record.variants.find((variant) => variant.sku === row.sku).variantGid, price: retailUsd(String(row.price)) }));
    if (variants.some((row) => !/^gid:\/\/shopify\/ProductVariant\/[0-9]+$/.test(row.id || ''))) throw new Error('Mapped price variant identifier is required');
    const payload = { productId: mapping.record.productGid, variants };
    payload.digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const aggregateKey = `product:${payload.productId}`;
    queued += await withTransaction(pool, async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shusha:price:${aggregateKey}`]);
      const latest = (await connection.query(`SELECT payload FROM shusha_bridge_outbox WHERE aggregate_key=$1
        AND kind='catalog.prices' ORDER BY created_at DESC,id DESC LIMIT 1`, [aggregateKey])).rows[0];
      if (latest?.payload.digest === payload.digest) return 0;
      await enqueue(connection, { intentKey: `price:${randomUUID()}`, kind: 'catalog.prices', aggregateKey, payload });
      return 1;
    });
  }
  return { queued };
}

const PRICE_MUTATION = `mutation BridgePrices($productId:ID!,$variants:[ProductVariantsBulkInput!]!){
  productVariantsBulkUpdate(productId:$productId,variants:$variants){productVariants{id price} userErrors{field}}
}`;
const PRICE_READ = `query BridgePriceRead($id:ID!){product(id:$id){variants(first:250){pageInfo{hasNextPage} nodes{id price}}}}`;

export async function applyPriceIntent(row, { client }) {
  const read = async () => {
    const data = await client.request(PRICE_READ, { id: row.payload.productId });
    if (!data.product || data.product.variants.pageInfo.hasNextPage) throw new Error('Complete mapped price readback is required');
    return row.payload.variants.every((desired) => data.product.variants.nodes.some((variant) => variant.id === desired.id && Number(variant.price) === Number(desired.price)));
  };
  if (await read()) return;
  await client.request(PRICE_MUTATION, { productId: row.payload.productId, variants: row.payload.variants }, { kind: 'mutation' });
  if (!(await read())) throw new Error('Price-only write needs successful native readback');
}

export async function openNewMappedCapacity(runtime, env = process.env) {
  if (!runtime.config.writesEnabled || env.SHOPIFY_SHARED_CAPACITY_ENABLED !== 'true' || env.SHOPIFY_INVENTORY_ACTIVATION_ENABLED !== 'true') return { opened: 0 };
  const mappings = (await runtime.pool.query("SELECT source_key,record FROM shusha_bridge_mapping WHERE kind='product' ORDER BY source_key")).rows;
  let opened = 0;
  for (const mapping of mappings) {
    if (mapping.record.activation?.locationId !== env.SHOPIFY_LOCATION_ID) continue;
    const skus = mapping.record.variants.map((variant) => variant.sku);
    const missing = (await runtime.pool.query('SELECT COUNT(*)::int AS count FROM shusha_bridge_inventory WHERE sku=ANY($1::text[])', [skus])).rows[0].count;
    if (missing === skus.length) continue;
    const product = (await runtime.client.request(`query BridgeOpeningOwner($id:ID!){product(id:$id){id status
      metafield(namespace:"shusha_bridge",key:"source_uuid"){value}}}`, { id: mapping.record.productGid })).product;
    if (product?.status !== 'DRAFT' || product.id !== mapping.record.productGid || product.metafield?.value !== mapping.source_key) {
      throw new Error('New capacity can be opened only for its owned Shopify draft');
    }
    const result = await withTransaction(runtime.pool, (connection) => openCapacity(connection, { skus }));
    opened += result.opened;
  }
  return { opened };
}

export async function runBridgeMinute(runtime, env = process.env) {
  const { pool, config, client, tokens } = runtime;
  if (!config.enabled || !config.writesEnabled) return { status: 'disabled', remoteWrites: false };
  const capacityEnabled = env.SHOPIFY_SHARED_CAPACITY_ENABLED === 'true';
  const inbox = await processInbox(pool, { client, tokens, expectedShop: config.shop, ordersEnabled: capacityEnabled });
  if (inbox.uninstalled) return { status: 'reauthorization-required', inbox, remoteWrites: false };
  const catalog = await createCatalogFollower(runtime, { env })();
  const opening = await openNewMappedCapacity(runtime, env);
  // Catalog price following can precede shared-capacity activation.
  const prices = await enqueuePriceChanges(pool);
  const inventoryClient = createShopifyClient({ shop: config.shop, getAccessToken: () => tokens.getAccessToken(), maxAttempts: 1 });
  const outbox = await processOutbox(pool, {
    client: capacityEnabled ? inventoryClient : client, writesEnabled: true,
    allowedKinds: capacityEnabled ? ['catalog.prices', 'inventory.shopify', 'inventory.evershop'] : ['catalog.prices'],
    resolveInventory: capacityEnabled ? (sku) => resolveInventory(pool, sku, env.SHOPIFY_LOCATION_ID) : undefined,
    handlers: { 'catalog.prices': (row) => applyPriceIntent(row, { client }) }
  });
  const content = await followPublishedCollections(runtime, env);
  return { status: inbox.failed || outbox.frozen || outbox.unknown ? 'attention' : 'completed', catalog, opening, prices, inbox, outbox, content };
}

export async function runBridgeReconcile(runtime, env = process.env) {
  const { pool, config, client } = runtime;
  if (!config.enabled || !config.writesEnabled || env.SHOPIFY_SHARED_CAPACITY_ENABLED !== 'true') return { status: 'disabled', remoteWrites: false };
  const owner = await pool.connect();
  let lock;
  try { lock = (await owner.query("SELECT pg_try_advisory_lock(hashtext('shusha:bridge:reconcile')) AS locked")).rows[0].locked; }
  catch (error) { owner.release(error); throw error; }
  if (!lock) { owner.release(); return { status: 'busy' }; }
  try {
    const saved = (await pool.query(`SELECT record FROM shusha_bridge_mapping WHERE kind='operation' AND source_key='reconcile-cursor'`)).rows[0]?.record;
    const startedAt = new Date().toISOString();
    const orders = await reconcileRecentOrders(pool, {
      client, since: saved?.updatedAt ? new Date(new Date(saved.updatedAt).getTime() - 15 * 60000).toISOString() : undefined,
      readAllOrders: config.scopes.includes('read_all_orders')
    });
    if (orders.complete) await pool.query(`INSERT INTO shusha_bridge_mapping(kind,source_key,record) VALUES('operation','reconcile-cursor',$1)
      ON CONFLICT(kind,source_key) DO UPDATE SET record=EXCLUDED.record,updated_at=NOW()`, [JSON.stringify({ updatedAt: startedAt })]);
    const capacity = await auditCapacity(pool, {
      resolveInventory: (sku) => resolveInventory(pool, sku, env.SHOPIFY_LOCATION_ID),
      readShopifyQuantity: async (mapping) => {
        const data = await client.request(`query BridgeAuditQuantity($id:ID!,$location:ID!){
          inventoryItem(id:$id){inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}
        }`, { id: mapping.inventoryItemId, location: mapping.locationId });
        return integer(data.inventoryItem?.inventoryLevel?.quantities?.find((quantity) => quantity.name === 'available')?.quantity);
      }
    });
    return { status: orders.complete && !capacity.newlyFrozen ? 'completed' : 'attention', orders, capacity };
  } finally { await releaseAdvisoryOwner(owner, "SELECT pg_advisory_unlock(hashtext('shusha:bridge:reconcile'))"); }
}
