#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import priceApi from '../scripts/lib/supplier-price-api.cjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_VERSION = '2.2.1';
const assert = (ok, message) => { if (!ok) throw new Error(message); };

export function parseMigrationArguments(argv) {
  const options = { allowProduction: false, worker: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--env-file') {
      options.envFile = argv[++i];
      assert(options.envFile && !options.envFile.startsWith('--'), 'An explicit private environment file is required');
    } else if (argument === '--allow-production') options.allowProduction = true;
    else if (argument === '--worker') options.worker = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error('Unsupported migration argument');
  }
  return options;
}

export function databaseGuard(env, allowProduction = false) {
  assert(['DB_HOST', 'DB_USER', 'DB_NAME'].every(name => typeof env[name] === 'string' && env[name]), 'Database environment is incomplete');
  if (/(?:^|[_-])(?:test|candidate)(?:[_-]|$)/i.test(env.DB_NAME)) return 'isolated';
  assert(allowProduction && env.SHUSHA_PRODUCTION_MIGRATION_GUARD === `v${PINNED_VERSION}:${env.DB_NAME}`, 'Production migration requires an explicit command flag and exact environment guard');
  return 'production';
}

export function sortVersions(versions) {
  return [...versions].sort((a, b) => {
    const aa = a.split('.').map(Number);
    const bb = b.split('.').map(Number);
    for (let index = 0; index < 3; index++) if (aa[index] !== bb[index]) return aa[index] - bb[index];
    return 0;
  });
}

async function versionsAt(directory, compiled = true) {
  let entries;
  try { entries = await fs.readdir(path.join(directory, 'migration'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const pattern = compiled ? /^Version-(\d+\.\d+\.\d+)\.js$/ : /^Version-(\d+\.\d+\.\d+)\.(?:js|ts)$/;
  return sortVersions([...new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name.match(pattern)?.[1]).filter(Boolean))]);
}

export async function expectedMigrationVersions(modules, app = APP) {
  const expected = [];
  const corePrefix = path.join(app, 'packages', 'evershop', 'dist', 'modules') + path.sep;
  for (const module of modules) {
    const compiled = await versionsAt(module.path);
    const source = module.path.startsWith(corePrefix)
      ? path.join(app, 'packages', 'evershop', 'src', 'modules', path.relative(corePrefix, module.path))
      : path.resolve(module.path, '..', 'src');
    const originals = await versionsAt(source, false);
    assert(originals.length === compiled.length && originals.every((version, index) => version === compiled[index]), 'Compiled migration set differs from its pinned source; rebuild before migration');
    if (compiled.length) expected.push({ module: module.name, version: compiled.at(-1) });
  }
  return expected;
}

export function verifyInstalledVersions(expected, rows) {
  const installed = new Map(rows.map(row => [row.module, row.version]));
  return expected.filter(row => installed.get(row.module) !== row.version).map(row => row.module);
}

export function workerOutcome({ code, output }, marker) {
  const messages = output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const completion = messages.findLast(message => message.migrationWorkerMarker === marker);
  if (code !== 0 || !completion || completion.status !== 'verified') {
    return { status: completion?.status === 'blocked' ? 'blocked' : 'failed', reason: completion?.reason || 'native-exit-without-verification', workerExitCode: code, counts: completion?.counts || {}, needsFreshRestore: completion?.needsFreshRestore !== false };
  }
  assert(completion.verifiedMigrationModules === completion.expectedMigrationModules, 'Worker migration verification is incomplete');
  return { status: 'verified', expectedMigrationModules: completion.expectedMigrationModules, verifiedMigrationModules: completion.verifiedMigrationModules, enabledCustomExtensions: completion.enabledCustomExtensions, counts: completion.counts, nativeCompletionMarkerVerified: true, needsFreshRestore: false };
}

async function configureRuntime(options) {
  process.chdir(APP);
  if (options.envFile) {
    const filename = await fs.realpath(path.resolve(APP, options.envFile));
    const original = await fs.realpath(path.join(APP, '.env')).catch(() => null);
    assert(path.basename(filename) !== '.env' && filename !== original, 'The existing root .env must never be read by this migration runner');
    const { parse } = await import('dotenv');
    Object.assign(process.env, parse(await fs.readFile(filename)));
  }
  const guard = databaseGuard(process.env, options.allowProduction);
  const manifest = JSON.parse(await fs.readFile(path.join(APP, 'packages', 'evershop', 'package.json'), 'utf8'));
  assert(manifest.version === PINNED_VERSION, 'Migration runtime must be pinned to EverShop v2.2.1');
  const settings = JSON.parse(await fs.readFile(path.join(APP, 'deployment', 'config.shusha.json'), 'utf8'));
  settings.system = { ...settings.system, jobs: [] };
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_CONFIG_MUTATIONS = 'true';
  process.env.NODE_CONFIG = JSON.stringify(settings);
  return { guard, settings };
}

async function nativeShippingSnapshot(pool) {
  const tables = (await pool.query("SELECT to_regclass('public.order') IS NOT NULL AS orders, to_regclass('public.shipment') IS NOT NULL AS shipments, to_regclass('public.migration') IS NOT NULL AS migration")).rows[0];
  if (!tables.orders || !tables.shipments) return { orders: [], shipments: [], counts: { pendingOrders: 0, riskyLegacyShipments: 0 }, installedOmsVersion: null };
  const orders = (await pool.query('SELECT order_id,uuid,shipment_status,payment_method FROM "order" ORDER BY order_id')).rows;
  const shipments = (await pool.query('SELECT * FROM shipment ORDER BY shipment_id')).rows;
  const states = new Map(orders.map(order => [order.order_id, order.shipment_status]));
  const risky = shipments.filter(shipment => ['pending', 'processing'].includes(states.get(shipment.shipment_order_id)) || states.get(shipment.shipment_order_id) === null);
  const installedOmsVersion = tables.migration ? (await pool.query("SELECT version FROM migration WHERE module='oms'")).rows[0]?.version || null : null;
  const willRunBackfill = !installedOmsVersion || sortVersions([installedOmsVersion, '1.0.3'])[0] === installedOmsVersion && installedOmsVersion !== '1.0.3';
  return { schemaVersion: 1, capturedAt: new Date().toISOString(), orders, shipments, installedOmsVersion, counts: { pendingOrders: orders.filter(order => ['pending', 'processing'].includes(order.shipment_status)).length, riskyLegacyShipments: willRunBackfill ? risky.length : 0 } };
}

async function emitAndExit(message, code) {
  await new Promise(resolve => process.stdout.write(`${JSON.stringify(message)}\n`, resolve));
  // Native migrate retains its migration-table connection. A dedicated worker
  // exits after explicit verification instead of waiting on an unreleased pool.
  process.exit(code);
}

async function worker(options, runtime) {
  const marker = process.env.SHUSHA_MIGRATION_WORKER_MARKER;
  assert(/^[a-f0-9-]{36}$/.test(marker || ''), 'Migration worker must be started by its guarded parent');
  const compiled = path.join(APP, 'packages', 'evershop', 'dist');
  const load = filename => import(pathToFileURL(path.join(compiled, filename)).href);
  const { pool } = await import('@evershop/evershop/lib/postgres');
  pool.options.connectionTimeoutMillis = 10000;
  const shipping = await nativeShippingSnapshot(pool);
  await fs.writeFile(path.join(process.env.SHUSHA_MIGRATION_RUN_DIR, 'pre-migration-shipping.private.json'), `${JSON.stringify(shipping, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (shipping.counts.riskyLegacyShipments) await emitAndExit({ migrationWorkerMarker: marker, status: 'blocked', reason: 'legacy-pending-shipment-backfill-risk', counts: shipping.counts, needsFreshRestore: false }, 2);
  const { getCoreModules } = await load('bin/lib/loadModules.js');
  const { getEnabledExtensions } = await load('bin/extension/index.js');
  const { loadBootstrapScript } = await load('bin/lib/bootstrap/bootstrap.js');
  const { migrate } = await load('bin/lib/bootstrap/migrate.js');
  const { lockHooks } = await import('@evershop/evershop/lib/util/hookable');
  const { lockRegistry } = await import('@evershop/evershop/lib/util/registry');
  const { lockCarrierRegistry } = await load('modules/oms/services/carrier/registry.js');
  const extensions = getEnabledExtensions();
  const configured = (runtime.settings.system.extensions || []).filter(extension => extension.enabled === true).map(extension => extension.name);
  assert(configured.every(name => extensions.some(extension => extension.name === name)), 'One or more enabled extensions were skipped by the native loader');
  const modules = [...getCoreModules(), ...extensions];
  const expected = await expectedMigrationVersions(modules);
  const hasMigrationTable = (await pool.query("SELECT to_regclass('public.migration') IS NOT NULL AS exists")).rows[0].exists;
  if (hasMigrationTable) {
    const previous = (await pool.query('SELECT module,version FROM migration')).rows;
    const latest = new Map(expected.map(row => [row.module, row.version]));
    assert(previous.every(row => !latest.has(row.module) || sortVersions([latest.get(row.module), row.version])[1] === latest.get(row.module)), 'The database contains a module newer than the pinned migration set');
  }
  for (const module of modules) await loadBootstrapScript(module, { command: 'migrate', env: 'production', process: 'main' });
  lockHooks(); lockRegistry(); lockCarrierRegistry();
  // Follow native per-version commits. A failed run requires a fresh candidate
  // restore, never an assumption that the whole multi-module run was atomic.
  await migrate(modules);
  const installed = (await pool.query('SELECT module,version FROM migration')).rows;
  const mismatches = verifyInstalledVersions(expected, installed);
  assert(mismatches.length === 0, 'Database module versions did not reach the complete pinned migration set');
  await fs.writeFile(path.join(process.env.SHUSHA_MIGRATION_RUN_DIR, 'verified-migrations.private.json'), `${JSON.stringify({ expected, installed, verifiedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await emitAndExit({ migrationWorkerMarker: marker, status: 'verified', expectedMigrationModules: expected.length, verifiedMigrationModules: expected.length, enabledCustomExtensions: extensions.length, counts: shipping.counts, needsFreshRestore: false }, 0);
}

async function parent(options) {
  const runtime = await configureRuntime(options);
  const marker = crypto.randomUUID();
  const directory = path.join(path.resolve(process.env.PRIVATE_DATA_DIR || path.join(APP, 'data')), 'migration-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${marker}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', ...(options.allowProduction ? ['--allow-production'] : [])], { cwd: APP, env: { ...process.env, SHUSHA_MIGRATION_WORKER_MARKER: marker, SHUSHA_MIGRATION_RUN_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8 * 1024 * 1024); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8 * 1024 * 1024); });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output, errors }); });
  });
  await fs.writeFile(path.join(directory, 'migration-output.private.log'), priceApi.redactError(`${result.output}\n${result.errors}`), { flag: 'wx', mode: 0o600 });
  const outcome = workerOutcome(result, marker);
  await fs.writeFile(path.join(directory, 'outcome.private.json'), `${JSON.stringify({ ...outcome, databaseGuard: runtime.guard }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.status !== 'verified') process.exitCode = 1;
}

async function main() {
  const options = parseMigrationArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node deployment/migrate-v2.mjs [--env-file private/candidate.env] [--allow-production]\nRequires pinned EverShop v2.2.1 compiled core/extensions. Never reads root .env. DB_NAME must contain a separate test/candidate token; production also requires SHUSHA_PRODUCTION_MIGRATION_GUARD=v2.2.1:<exact DB_NAME>. Private migration journals are stored below PRIVATE_DATA_DIR. Native exit 0 is not acceptance without a verified completion marker and all module versions.');
    return;
  }
  if (options.worker) await worker(options, await configureRuntime(options));
  else await parent(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(async error => {
  if (process.env.SHUSHA_MIGRATION_WORKER_MARKER) {
    // Parent saves this diagnostic privately; no database error text is exposed
    // in its public outcome.
    console.error(priceApi.redactError(error));
    await emitAndExit({ migrationWorkerMarker: process.env.SHUSHA_MIGRATION_WORKER_MARKER, status: 'failed', reason: 'migration-runner-failed', counts: {}, needsFreshRestore: true }, 1);
  } else { console.error('Guarded v2 migration failed; private database and environment details are withheld'); process.exitCode = 1; }
});
