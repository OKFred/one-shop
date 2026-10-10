#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildCatalogSnapshot } from '../../extensions/shopify-bridge/src/services/catalog.js';

export async function exportCatalog({ env = process.env, pool = null, output = null } = {}) {
  const privateRoot = path.resolve(env.PRIVATE_DATA_DIR || path.join(process.cwd(), 'data'));
  const directory = path.join(privateRoot, 'shopify');
  const filename = path.resolve(output || path.join(directory, 'catalog.private.json'));
  if (!filename.startsWith(`${directory}${path.sep}`) || !filename.endsWith('.private.json')) throw new Error('Catalog export must remain under the private Shopify data directory');
  const materialRoot = path.resolve(env.MATERIAL_LIBRARY_DIR || env.SHUSHA_MATERIAL_LIBRARY_DIR || path.join(privateRoot, 'material-library'));
  const mediaRoot = path.resolve(env.MATERIAL_MEDIA_DIR || path.join(process.cwd(), 'media/source-library'));
  const [storeMap, mediaIndex] = await Promise.all(['store-map.json', 'media-index.json'].map(async (name) => JSON.parse(await fs.readFile(path.join(materialRoot, name), 'utf8'))));
  const ownsPool = !pool;
  if (!pool) {
    if (!['DB_HOST', 'DB_USER', 'DB_NAME'].every((name) => env[name])) throw new Error('Runtime database environment is incomplete');
    ({ pool } = await import('@evershop/evershop/lib/postgres'));
  }
  const db = await pool.connect();
  try {
    const snapshot = await buildCatalogSnapshot({ db, storeMap, mediaIndex, mediaRoot });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const realDirectory = await fs.realpath(directory);
    const realPrivateRoot = await fs.realpath(privateRoot);
    if (!realDirectory.startsWith(`${realPrivateRoot}${path.sep}`) || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('Private export directory must not escape through a symlink');
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
    const temp = `${filename}.${randomUUID()}.tmp`;
    const file = await fs.open(temp, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temp, filename);
    return { status: 'private-export-complete', styles: snapshot.styles.length, variants: snapshot.styles.reduce((count, style) => count + style.variants.length, 0), contentSha256: snapshot.contentSha256, customerRecords: 0, historicalOrders: 0 };
  } finally { db.release(); if (ownsPool) await pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: export-catalog.mjs [--output private-data/shopify/catalog.private.json]');
  try { console.log(JSON.stringify(await exportCatalog({ output: args[1] }))); }
  catch (_) { console.error('Shopify catalog export failed; inspect private source/map/media evidence without publishing it'); process.exitCode = 1; }
}
