#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeRawHtml } from '@evershop/evershop/lib/util/sanitizeHtml';
import { buildPublicCompanyPages, loadPublicMerchantProfile } from '../scripts/merchant/public-profile.mjs';
import { createDatabasePool, canonical, hash } from './capture-baseline.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const HANDLES = Object.freeze(['about', 'contact']);
const REQUIRED_TABLES = Object.freeze(['cms_page', 'cms_page_description', 'url_rewrite', 'setting', 'product', 'product_description', 'product_inventory', 'order', 'order_item']);
const identifier = value => {
  assert(typeof value === 'string' && /^[a-z_][a-z0-9_]*$/.test(value), 'Unsupported company content database identifier');
  return `"${value}"`;
};

export function parseCompanyContentOptions(args, env = process.env) {
  const options = { action: 'dry-run' };
  let action;
  const names = { '--expected-database': 'expectedDatabase', '--profile': 'profileFile', '--expected-content-sha256': 'expectedContentSha256' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--dry-run', '--apply', '--verify'].includes(argument)) {
      assert(!action, 'Choose exactly one company content action');
      action = argument.slice(2); options.action = action;
    } else if (Object.hasOwn(names, argument)) {
      const key = names[argument]; const value = args[++index];
      assert(!options[key] && value && !value.startsWith('--'), 'Company content argument is missing or duplicated');
      options[key] = value;
    } else if (argument === '--help') options.help = true;
    else throw new Error('Unsupported company content argument');
  }
  options.profileFile ||= env.SHUSHA_PUBLIC_PROFILE_FILE;
  if (!options.help) {
    assert(typeof options.expectedDatabase === 'string' && options.expectedDatabase.trim().length > 0, '--expected-database must name the exact target');
    assert(typeof options.profileFile === 'string' && options.profileFile.trim().length > 0, 'An explicit private public-profile file is required');
    assert(options.expectedContentSha256 === undefined || /^[a-f0-9]{64}$/.test(options.expectedContentSha256), 'Invalid company content review digest');
    assert(options.action !== 'apply' || options.expectedContentSha256, '--apply requires the review digest from a fresh dry run');
  }
  return options;
}

// Use the native sanitizer and native Editor rows; no core patch or CMS URL
// service is needed when only the existing description fields change.
export function companyEditorRows(page) {
  assert(HANDLES.includes(page?.handle) && typeof page.bodyHtml === 'string' && page.bodyHtml.length <= 65_536, 'Invalid public company page');
  const rows = [{ id: `shusha-company-${page.handle}`, size: 1, columns: [{
    id: `shusha-company-${page.handle}-column`, size: 1,
    data: { blocks: [{ id: `shusha-company-${page.handle}-body`, type: 'raw', data: { html: page.bodyHtml } }], version: '2.30.2' }
  }] }];
  sanitizeRawHtml(rows);
  assert(rows[0].columns[0].data.blocks[0].data.html.trim().length > 0, 'Sanitized public company page is empty');
  return rows;
}

async function listTables(client, schema) {
  const rows = (await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name`, [schema])).rows;
  const tables = rows.map(row => row.table_name);
  assert(REQUIRED_TABLES.every(table => tables.includes(table)), 'Required native company content or protected business tables are missing');
  for (const table of tables) identifier(table);
  return tables;
}

async function protectedDigests(client, schema, tables, managedDescriptionIds) {
  const result = {};
  for (const table of tables) {
    const selected = table === 'cms_page_description'
      ? `CASE WHEN t.cms_page_description_id=ANY($1::int[]) THEN to_jsonb(t)-'name'-'content' ELSE to_jsonb(t) END`
      : 'to_jsonb(t)';
    // A consistent serializable snapshot sees our own writes but does not treat
    // another checkout's committed changes as our changes. Private rows stay in
    // memory; only counts and a review digest leave this script.
    const query = `SELECT count(*)::text AS count, COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb) AS value
      FROM (SELECT ${selected} AS v FROM ${identifier(schema)}.${identifier(table)} t) protected`;
    const row = (await client.query(query, table === 'cms_page_description' ? [managedDescriptionIds] : [])).rows[0];
    result[table] = { count: row.count, digest: hash(row.value) };
  }
  return result;
}

export async function applyCompanyContent(client, options, { profile } = {}) {
  assert(['dry-run', 'apply', 'verify'].includes(options?.action), 'Unsupported company content action');
  assert(typeof options.expectedDatabase === 'string' && options.expectedDatabase.length > 0, 'The exact target database is required');
  assert(options.action !== 'apply' || /^[a-f0-9]{64}$/.test(options.expectedContentSha256 || ''), 'A fresh company content review digest is required');
  const desired = buildPublicCompanyPages(profile).map(page => ({ handle: page.handle, name: page.title, content: JSON.stringify(companyEditorRows(page)) }));
  assert(desired.length === HANDLES.length && HANDLES.every(handle => desired.filter(page => page.handle === handle).length === 1), 'Public company page identities differ');
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const location = (await client.query('SELECT current_database() AS database, current_schema() AS schema')).rows[0];
    assert(location.database === options.expectedDatabase, 'Connected database does not match the exact target; nothing changed');
    identifier(location.schema);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shusha-company-content-v1'))");
    const tables = await listTables(client, location.schema);
    const pageTable = `${identifier(location.schema)}.cms_page`;
    const descriptionTable = `${identifier(location.schema)}.cms_page_description`;
    const readPages = async () => (await client.query(`SELECT to_jsonb(p) AS page, to_jsonb(d) AS description
      FROM ${pageTable} p JOIN ${descriptionTable} d ON d.cms_page_description_cms_page_id=p.cms_page_id
      WHERE d.url_key=ANY($1::text[]) ORDER BY d.url_key FOR UPDATE OF p,d`, [HANDLES])).rows;
    const current = await readPages();
    assert(current.every(row => HANDLES.includes(row.description.url_key)) && new Set(current.map(row => row.description.url_key)).size === current.length, 'Managed company page is ambiguous');
    const missingPages = HANDLES.filter(handle => !current.some(row => row.description.url_key === handle));
    assert(options.action === 'dry-run' || missingPages.length === 0, 'A managed company page is missing; create it in native CMS before applying');
    const reviewContentSha256 = hash({ current, desired, profileSha256: hash(profile) });
    if (options.action === 'apply') assert(reviewContentSha256 === options.expectedContentSha256, 'Company content or public profile changed after review; nothing changed');
    const changed = desired.filter(page => {
      const row = current.find(row => row.description.url_key === page.handle);
      return row && (row.description.name !== page.name || row.description.content !== page.content);
    });
    const ids = current.map(row => row.description.cms_page_description_id);
    const before = await protectedDigests(client, location.schema, tables, ids);
    if (options.action === 'verify') assert(changed.length === 0, 'Public company content is not fully applied');
    if (options.action === 'apply') {
      for (const page of changed) {
        const row = current.find(row => row.description.url_key === page.handle);
        const update = await client.query(`UPDATE ${descriptionTable} SET name=$1,content=$2
          WHERE cms_page_description_id=$3 AND cms_page_description_cms_page_id=$4 AND url_key=$5`,
        [page.name, page.content, row.description.cms_page_description_id, row.page.cms_page_id, page.handle]);
        assert(update.rowCount === 1, 'Managed company page update did not affect exactly one row');
      }
      const after = await protectedDigests(client, location.schema, tables, ids);
      assert(canonical(before) === canonical(after), 'Protected business data or unrelated content changed; transaction rolled back');
      const readback = await readPages();
      assert(readback.length === HANDLES.length && desired.every(page => readback.some(row => row.description.url_key === page.handle && row.description.name === page.name && row.description.content === page.content)), 'Company content readback differs; transaction rolled back');
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    return { status: missingPages.length ? 'missing-pages' : options.action === 'apply' ? 'applied' : options.action === 'verify' ? 'verified' : 'dry-run-complete',
      reviewContentSha256, missingPages,
      counts: { foundPages: current.length, activePages: current.filter(row => row.page.status === true).length, changedPages: changed.length, protectedTables: tables.length },
      protectedDataVerified: options.action === 'apply' };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (cleanupError) { error.connectionCleanupError = cleanupError; }
    throw error;
  }
}

async function main() {
  const options = parseCompanyContentOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node deployment/apply-company-content.mjs [--dry-run | --verify | --apply --expected-content-sha256 SHA256] --expected-database EXACT_DATABASE [--profile PRIVATE_FILE]\nDefaults to dry run. Requires an explicit --profile or SHUSHA_PUBLIC_PROFILE_FILE and runtime DB_* variables. Preview after a fresh backup; apply its review digest without intervening CMS/profile edits. Existing about/contact pages are required. Only their description name/content change; UUIDs, status, URLs, SEO, other content and business records are protected. Reports counts and hashes only.');
    return;
  }
  const profile = await loadPublicMerchantProfile({ env: { ...process.env, SHUSHA_PUBLIC_PROFILE_FILE: options.profileFile } });
  const pool = await createDatabasePool();
  let client; let cleanupError;
  try { client = await pool.connect(); console.log(JSON.stringify(await applyCompanyContent(client, options, { profile }))); }
  catch (error) { cleanupError = error.connectionCleanupError; throw error; }
  finally { client?.release(cleanupError); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Company content update failed; private inputs and database details are withheld'); process.exitCode = 1; });
}
