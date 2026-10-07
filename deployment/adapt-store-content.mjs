#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabasePool, hash, canonical } from './capture-baseline.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const PACKING_PLACEHOLDER = 'Packing pending — manually confirm dimensions';
export const BRANDING = Object.freeze({ storeName: 'SHUSHA', storeCurrency: 'USD', logo: '/assets/shusha/shusha-wordmark.svg', logoWidth: '200', logoHeight: '40' });
export const LEGACY_CUSTOMER_FOOTER_NAME = 'shusha-customer-information';
export const LEGACY_CUSTOMER_FOOTER_ARCHIVE = 'shushaLegacyFooterArchive';
const CATEGORY_PATHS = ['/dresses', '/pants', '/tops'];

export function parseOptions(args) {
  const options = { action: 'dry-run' };
  let action;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['--apply', '--dry-run', '--verify'].includes(value)) {
      assert(!action, 'Choose exactly one content adaptation action');
      action = value.slice(2); options.action = action;
    } else if (value === '--expected-database') {
      assert(!options.expectedDatabase && args[index + 1] && !args[index + 1].startsWith('--'), 'An exact expected database name is required');
      options.expectedDatabase = args[++index];
    } else if (value === '--help') options.help = true;
    else throw new Error('Unknown content adaptation argument');
  }
  options.expectedDatabase ||= process.env.SHUSHA_MIGRATION_TARGET_DB;
  assert(options.help || typeof options.expectedDatabase === 'string' && options.expectedDatabase.length > 0,
    'Set --expected-database or SHUSHA_MIGRATION_TARGET_DB to the exact isolated target');
  return options;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch {}
  }
  return null;
}

export function normalizedMainMenu(widget) {
  if (widget.type !== 'basic_menu') return null;
  const settings = typeof widget.settings === 'string' ? JSON.parse(widget.settings) : widget.settings;
  const main = [true, 1, '1', 'true'].includes(settings?.isMain);
  if (!main) return null;
  const menus = parseArray(settings?.menus);
  assert(menus, 'Main menu settings are not a valid array');
  if (!CATEGORY_PATHS.every(url => menus.some(item => item.type === 'custom' && item.url === url))) return null;
  const normalized = menus.map(item => {
    const children = item.children === undefined ? [] : parseArray(item.children);
    assert(children, 'Managed menu children are not a valid array');
    return { ...item, children };
  });
  return { ...settings, isMain: true, menus: normalized };
}

export function choosePackingPlaceholder(rows) {
  const placeholders = rows.filter(row => row.name === PACKING_PLACEHOLDER);
  assert(placeholders.length <= 1, 'Packing placeholder is ambiguous');
  if (placeholders.length) return { row: placeholders[0], rename: false };
  const seeded = rows.filter(row => row.name === 'Standard Box');
  assert(seeded.length === 1 && seeded[0].is_default === true && Number(seeded[0].length) === 30 && Number(seeded[0].width) === 25 && Number(seeded[0].height) === 10 && Number(seeded[0].weight) === 0,
    'Native unedited starter parcel is unavailable; do not rename merchant packing data');
  return { row: seeded[0], rename: true };
}

async function protectedState(client, managedMenuIds) {
  // In-memory hashes only; no business/customer rows are printed or persisted.
  const queries = {
    products: `SELECT COALESCE(jsonb_agg(to_jsonb(p)-'package_id'-'updated_at' ORDER BY product_id),'[]'::jsonb) AS value FROM product p`,
    inventory: `SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY product_inventory_id),'[]'::jsonb) AS value FROM product_inventory i`,
    descriptions: `SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY product_description_id),'[]'::jsonb) AS value FROM product_description d`,
    cmsPages: `SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY cms_page_id),'[]'::jsonb) AS value FROM cms_page p`,
    cmsDescriptions: `SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY cms_page_description_id),'[]'::jsonb) AS value FROM cms_page_description d`,
    contentWidgets: `SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY widget_instance_id),'[]'::jsonb) AS value FROM widget_instance w WHERE NOT(widget_instance_id=ANY($1::int[]))`,
    orders: `SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY order_id),'[]'::jsonb) AS value FROM "order" o`,
    orderItems: `SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY order_item_id),'[]'::jsonb) AS value FROM order_item i`
  };
  const digests = {};
  for (const [key, sql] of Object.entries(queries)) {
    const value = (await client.query(sql, key === 'contentWidgets' ? [managedMenuIds] : [])).rows[0].value;
    digests[key] = hash(value);
  }
  return digests;
}

export async function adaptStoreContent(client, options, { verifyLogo = true, mediaDir = path.join(process.cwd(), 'media') } = {}) {
  if (verifyLogo) {
    const filename = path.join(mediaDir, 'shusha/shusha-wordmark.svg');
    const info = await fs.lstat(filename);
    assert(info.isFile() && !info.isSymbolicLink() && info.size > 0, 'The existing SHUSHA wordmark file is missing or invalid');
    const svg = await fs.readFile(filename, 'utf8');
    assert(/<svg\b/.test(svg) && /width="200"/.test(svg) && /height="40"/.test(svg) && /SHUSHA/.test(svg), 'Wordmark does not match its known dimensions and brand');
  }
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    assert(database === options.expectedDatabase, 'Connected database does not match the exact target; nothing changed');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shusha-store-content-v2'))");
    await client.query('LOCK TABLE widget_instance,widget_placement,setting,package,product IN SHARE ROW EXCLUSIVE MODE');
    const widgets = (await client.query('SELECT * FROM widget_instance ORDER BY widget_instance_id FOR UPDATE')).rows;
    const menus = widgets.map(widget => ({ widget, settings: normalizedMainMenu(widget) })).filter(item => item.settings);
    assert(menus.some(item => item.widget.status === true), 'The preserved SHUSHA main menu is missing');
    const menuIds = menus.map(item => item.widget.widget_instance_id);
    const placements = (await client.query('SELECT * FROM widget_placement ORDER BY widget_placement_id FOR UPDATE')).rows;
    for (const id of menuIds) assert(placements.some(row => row.widget_instance_id === id && row.route === 'all' && ['header','headerMiddleLeft'].includes(row.area)), 'Managed main menu has no compatible global placement');
    const heroPlacements = placements.filter(row => row.route === 'homepage' && row.area === 'content' && widgets.some(widget => widget.widget_instance_id === row.widget_instance_id && widget.type === 'text_block' && widget.status));
    assert(heroPlacements.length > 0, 'The migrated homepage content is missing; restore existing CMS before adapting');
    const initial = await protectedState(client, menuIds);
    const settings = (await client.query('SELECT name,value,is_json FROM setting WHERE name=ANY($1::text[]) FOR UPDATE', [Object.keys(BRANDING)])).rows;
    const settingsToWrite = Object.entries(BRANDING).filter(([name, value]) => !settings.some(row => row.name === name && row.value === value && row.is_json === false));
    const menuChanges = menus.filter(({ widget, settings }) => canonical(widget.settings) !== canonical(settings));
    // The brand extension now renders the customer links and payment support.
    // Preserve the exact legacy widget bytes in an unrendered archive area.
    const legacyCustomerFooterIds = widgets.filter(widget => widget.name === LEGACY_CUSTOMER_FOOTER_NAME && widget.type === 'text_block').map(widget => widget.widget_instance_id);
    const placementChanges = placements.flatMap(row => {
      const archived = legacyCustomerFooterIds.includes(row.widget_instance_id) && ['footer', 'footerTop'].includes(row.area);
      if (archived) return [{ row, area: LEGACY_CUSTOMER_FOOTER_ARCHIVE }];
      if (row.area === 'header' && menuIds.includes(row.widget_instance_id)) return [{ row, area: 'headerMiddleLeft' }];
      if (row.area === 'footer') return [{ row, area: 'footerTop' }];
      return [];
    });
    for (const { row, area } of placementChanges) assert(!placements.some(other => other.widget_placement_id !== row.widget_placement_id && other.widget_instance_id === row.widget_instance_id && other.route === row.route && other.area === area && (other.entity_urn || '') === (row.entity_urn || '')), 'Legacy placement would duplicate an existing v2 placement');
    const packages = (await client.query('SELECT * FROM package WHERE name=ANY($1::text[]) FOR UPDATE', [['Standard Box', PACKING_PLACEHOLDER]])).rows;
    const packing = choosePackingPlaceholder(packages);
    const packageId = packing.row.package_id;
    const unassigned = Number((await client.query("SELECT count(*) AS count FROM product WHERE LEFT(sku,7)='SHUSHA-' AND package_id IS NULL AND no_shipping_required IS NOT TRUE")).rows[0].count);
    const planned = { settings: settingsToWrite.length, menus: menuChanges.length, placements: placementChanges.length, archivedCustomerFooterPlacements: placementChanges.filter(item => item.area === LEGACY_CUSTOMER_FOOTER_ARCHIVE).length, parcelRenames: packing.rename ? 1 : 0, parcelBindings: unassigned };
    if (options.action === 'verify') assert(Object.values(planned).every(count => count === 0), 'Store content adaptation is incomplete');
    if (options.action === 'apply') {
      for (const [name, value] of settingsToWrite) await client.query('INSERT INTO setting(name,value,is_json) VALUES($1,$2,FALSE) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,is_json=FALSE', [name, value]);
      for (const { widget, settings } of menuChanges) await client.query('UPDATE widget_instance SET settings=$1 WHERE widget_instance_id=$2', [JSON.stringify(settings), widget.widget_instance_id]);
      for (const { row, area } of placementChanges) await client.query('UPDATE widget_placement SET area=$1 WHERE widget_placement_id=$2', [area, row.widget_placement_id]);
      if (packing.rename) await client.query('UPDATE package SET name=$1 WHERE package_id=$2 AND name=$3', [PACKING_PLACEHOLDER, packageId, 'Standard Box']);
      if (unassigned) await client.query("UPDATE product SET package_id=$1 WHERE LEFT(sku,7)='SHUSHA-' AND package_id IS NULL AND no_shipping_required IS NOT TRUE", [packageId]);
      const after = await protectedState(client, menuIds);
      assert(canonical(initial) === canonical(after), 'Protected CMS, stock, identity, price or historical order data changed; transaction rolled back');
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    return { status: options.action === 'apply' ? 'applied' : options.action === 'verify' ? 'verified' : 'dry-run-complete', counts: planned, preservedHomepageBlocks: heroPlacements.length, packageId, packingDimensionsVerified: false };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log('Usage: node deployment/adapt-store-content.mjs [--dry-run | --apply | --verify] --expected-database EXACT_TARGET\nRun after native v2 migration against an isolated database and existing private media copy. Reports counts and parcel ID only. Preserves CMS copy, source prices, stock and historical order data.'); return; }
  const pool = await createDatabasePool();
  let client;
  try {
    client = await pool.connect();
    console.log(JSON.stringify(await adaptStoreContent(client, options, { mediaDir: process.env.SHUSHA_MEDIA_DIR || path.join(process.cwd(), 'media') })));
  } finally { client?.release(); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('Store content adaptation failed; database and private content details are withheld'); process.exitCode = 1; });
