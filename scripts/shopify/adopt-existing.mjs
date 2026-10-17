#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCatalogAdopter, adoptionHash, sourceIdentitySha256 } from '../../extensions/shopify-bridge/src/services/adoption.js';
import { validateCatalogSnapshot } from '../../extensions/shopify-bridge/src/services/catalog.js';
import { exportCatalog } from './export-catalog.mjs';

const CLOSED = ['SHOPIFY_BRIDGE_JOBS_ENABLED', 'SHOPIFY_SHARED_CAPACITY_ENABLED', 'SHOPIFY_INVENTORY_ACTIVATION_ENABLED',
  'SHOPIFY_CATALOG_PUBLICATION_ENABLED', 'SHOPIFY_CONTENT_SYNC_ENABLED', 'SHOPIFY_PAYMENT_OPERATIONS_ENABLED', 'SHOPIFY_ORDER_OPERATIONS_ENABLED'];
const SCOPES = ['read_products', 'write_products', 'read_files', 'write_files', 'read_inventory', 'read_locations'];
const check = (condition, message) => { if (!condition) throw new Error(message); };

async function readPrivate(filename, root) {
  const resolved = path.resolve(filename), realRoot = await fs.realpath(path.join(root, 'shopify'));
  check(resolved.startsWith(`${realRoot}${path.sep}`) && await fs.realpath(resolved) === resolved && resolved.endsWith('.private.json'), 'Adoption input must be a private Shopify JSON file');
  const stat = await fs.lstat(resolved);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16 * 1024 * 1024 &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0), 'Private adoption input permissions or bounds differ');
  return JSON.parse(await fs.readFile(resolved, 'utf8'));
}

async function writePrivate(filename, data) {
  const file = await fs.open(filename, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(data, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function freshNative({ runtime, env, directory, exporter }) {
  const filename = path.join(directory, `source-${randomUUID()}.private.json`);
  await exporter({ env, pool: runtime.pool, output: filename });
  return validateCatalogSnapshot(await readPrivate(filename, path.resolve(env.PRIVATE_DATA_DIR || path.join(process.cwd(), 'data'))));
}

function verifyNativeIdentities(expected, current) {
  check(expected.length === current.styles.length && expected.every(style => {
    const live = current.styles.find(row => row.sourceUuid === style.sourceUuid);
    return live && sourceIdentitySha256(live) === (style.sourceIdentitySha256 || sourceIdentitySha256(style));
  }), 'Current reviewed native UUID/SKU/options differ; prepare a new audited proposal');
}

export async function adoptExisting({ env = process.env, runtime = null, proposalPath = null, planPath = null,
  reviewedSha256 = null, apply = false, exporter = exportCatalog } = {}) {
  check(env.SHOPIFY_BRIDGE_ENABLED === 'true' && env.SHOPIFY_BRIDGE_WRITES_ENABLED === 'true' && CLOSED.every(name => env[name] !== 'true'),
    'Existing adoption requires only the authenticated minimal catalog stage, with jobs and other capabilities closed');
  const root = path.resolve(env.PRIVATE_DATA_DIR || path.join(process.cwd(), 'data'));
  const ownsRuntime = !runtime;
  if (!runtime) { const { bridgeRuntime } = await import('../../extensions/shopify-bridge/src/services/runtime.js'); runtime = bridgeRuntime(); }
  let directory;
  try {
    check(runtime.config.enabled && runtime.config.writesEnabled && runtime.config.scopes.length === SCOPES.length && SCOPES.every(scope => runtime.config.scopes.includes(scope)),
      'Only the six approved catalog/inventory-read scopes are permitted');
    const adopter = createCatalogAdopter({ client: runtime.client, mappingStore: runtime.repositories.mappings });
    if (!apply) {
      check(proposalPath && !planPath && !reviewedSha256, 'Prepare requires the original private audit proposal only');
      const proposal = await readPrivate(proposalPath, root);
      const auditDirectory = path.dirname(path.resolve(proposalPath));
      const auditSuccess = await readPrivate(path.join(auditDirectory, 'success.private.json'), root);
      check(auditSuccess.status === 'existing-catalog-readonly-audited-no-adoption' && auditSuccess.proposalSha256 === proposal.proposalSha256 &&
        auditSuccess.nativeAndMappingsUnchanged === true && auditSuccess.providerCatalogAndInventoryStableAcrossReadbacks === true &&
        auditSuccess.providerWrites === 0 && auditSuccess.mappingWrites === 0, 'The original read-only audit did not complete successfully');
      const snapshot = validateCatalogSnapshot(await readPrivate(path.join(auditDirectory, 'native-catalog.private.json'), root));
      check(proposal.shop === runtime.config.shop, 'Audited proposal belongs to another shop');
      const parent = path.join(root, 'shopify/adoption');
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      check(await fs.realpath(parent) === parent, 'Private adoption directory cannot escape through a symlink');
      directory = path.join(parent, randomUUID()); await fs.mkdir(directory, { mode: 0o700 });
      const current = await freshNative({ runtime, env, directory, exporter });
      verifyNativeIdentities(snapshot.styles, current);
      const plan = await adopter.prepare({ proposal, snapshot });
      const filename = path.join(directory, 'plan.private.json');
      await writePrivate(filename, plan);
      return { status: 'existing-adoption-plan-prepared', planPath: filename, preparedSha256: plan.preparedSha256,
        styles: plan.styles.length, variants: plan.styles.reduce((sum, style) => sum + style.variants.length, 0), providerWrites: 0, mappingWrites: 0 };
    }
    check(planPath && !proposalPath && /^[a-f0-9]{64}$/.test(reviewedSha256 || ''), 'Apply requires the original private plan and its reviewed hash');
    const plan = await readPrivate(planPath, root);
    check(plan.shop === runtime.config.shop && plan.preparedSha256 === reviewedSha256, 'Reviewed adoption shop/hash differs');
    directory = path.dirname(path.resolve(planPath));
    check(directory.startsWith(`${path.join(root, 'shopify/adoption')}${path.sep}`), 'Apply requires its original private adoption directory');
    const current = await freshNative({ runtime, env, directory, exporter });
    verifyNativeIdentities(plan.styles, current);
    const attempt = randomUUID();
    await writePrivate(path.join(directory, `apply-${attempt}.private.json`), { status: 'requested', requestedAt: new Date().toISOString(),
      preparedSha256: reviewedSha256, planFileSha256: adoptionHash(plan), originalIntentsRetained: true });
    const result = await adopter.apply(plan, { reviewedSha256 });
    await writePrivate(path.join(directory, `result-${attempt}.private.json`), result);
    return { status: result.status, adopted: result.adopted, existing: result.existing, priceWrites: result.priceWrites,
      inventoryWrites: result.inventoryWrites, publicationWrites: result.publicationWrites,
      existingPriceOnlyAdoption: true, newDraftProviderAcceptanceClaimed: false, jobsEnabled: false };
  } catch (error) {
    if (directory) await writePrivate(path.join(directory, `failure-${randomUUID()}.private.json`), {
      status: 'existing-adoption-review-required', originalIntentsRetained: true, automaticRetry: false,
      detailsWithheld: true, recordedAt: new Date().toISOString()
    }).catch(() => {});
    throw error;
  } finally { if (ownsRuntime) await runtime.pool.end(); }
}

async function main() {
  const arguments_ = process.argv.slice(2), options = {};
  const flags = { '--proposal': 'proposalPath', '--plan': 'planPath', '--reviewed-sha256': 'reviewedSha256' };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--apply' && !options.apply) options.apply = true;
    else {
      check(flags[argument] && arguments_[index + 1] && !options[flags[argument]], 'Invalid adoption arguments');
      options[flags[argument]] = arguments_[++index];
    }
  }
  console.log(JSON.stringify(await adoptExisting(options)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error(JSON.stringify({ status: 'existing-adoption-review-required', detailsWithheld: true,
    action: 'Read the original private audit, plan and operation journal; do not recreate products or reset stock' }));
  process.exitCode = 1;
});
