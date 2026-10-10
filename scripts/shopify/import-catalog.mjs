#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatalogImporter, validateCatalogSnapshot, activateInventory } from '../../extensions/shopify-bridge/src/services/catalog.js';

export async function importCatalog({ env = process.env, runtime = null, input = null, apply = false, activate = false } = {}) {
  const privateRoot = path.resolve(env.PRIVATE_DATA_DIR || path.join(process.cwd(), 'data'));
  const directory = path.join(privateRoot, 'shopify');
  const filename = path.resolve(input || path.join(directory, 'catalog.private.json'));
  if (!filename.startsWith(`${directory}${path.sep}`) || !filename.endsWith('.private.json')) throw new Error('Import reads only the private Shopify catalog snapshot');
  const snapshot = validateCatalogSnapshot(JSON.parse(await fs.readFile(filename, 'utf8')));
  if (!apply) return { status: 'dry-run', styles: snapshot.styles.length, variants: snapshot.styles.reduce((count, style) => count + style.variants.length, 0), currency: 'USD', remoteWrites: false };
  if (env.SHOPIFY_BRIDGE_ENABLED !== 'true' || env.SHOPIFY_BRIDGE_WRITES_ENABLED !== 'true') throw new Error('Shopify server writes require explicit runtime enablement');
  if (activate && env.SHOPIFY_INVENTORY_ACTIVATION_ENABLED !== 'true') throw new Error('Inventory activation requires separate reviewed phase-three enablement');
  const ownsRuntime = !runtime;
  if (!runtime) { const { bridgeRuntime } = await import('../../extensions/shopify-bridge/src/services/runtime.js'); runtime = bridgeRuntime(); }
  try {
    const result = await createCatalogImporter({ client: runtime.client, mappingStore: runtime.repositories.mappings,
      mediaRoot: path.resolve(env.MATERIAL_MEDIA_DIR || path.join(process.cwd(), 'media/source-library')) }).importSnapshot(snapshot, { apply: true });
    if (activate) result.inventoryActivation = await activateInventory({ mappingStore: runtime.repositories.mappings, client: runtime.client, locationId: env.SHOPIFY_LOCATION_ID, styles: snapshot.styles, apply: true });
    return result;
  } finally { if (ownsRuntime) await runtime.pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); let apply = false; let activate = false; let input;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--activate-inventory' && !activate) activate = true;
    else if (args[i] === '--input' && !input && args[i + 1]) input = args[++i];
    else throw new Error('Usage: import-catalog.mjs [--input private-data/shopify/catalog.private.json] [--apply] [--activate-inventory]');
  }
  try { console.log(JSON.stringify(await importCatalog({ input, apply, activate }))); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code || 'SHOPIFY_CATALOG_REVIEW_REQUIRED', message: 'Inspect the private mapping and original operation journal; do not blindly recreate products or files' })); process.exitCode = 1; }
}
