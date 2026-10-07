import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseGuard, parseMigrationArguments, sortVersions, workerOutcome, verifyInstalledVersions, shippingRiskCounts } from '../../deployment/migrate-v2.mjs';

test('isolated database names are guarded and production needs exact two-part authorization', () => {
  const env = { DB_HOST: 'test-only.example.invalid', DB_USER: 'test-user', DB_NAME: 'shusha_v2_test' };
  assert.equal(databaseGuard(env), 'isolated');
  assert.equal(databaseGuard({ ...env, DB_NAME: 'shusha_candidate_1' }), 'isolated');
  const production = { ...env, DB_NAME: 'shusha_live' };
  assert.throws(() => databaseGuard(production), /explicit/);
  assert.throws(() => databaseGuard(production, true), /exact/);
  assert.throws(() => databaseGuard({ ...production, SHUSHA_PRODUCTION_MIGRATION_GUARD: 'v2.2.1:another_database' }, true), /exact/);
  assert.equal(databaseGuard({ ...production, SHUSHA_PRODUCTION_MIGRATION_GUARD: 'v2.2.1:shusha_live' }, true), 'production');
  assert.throws(() => databaseGuard({ ...production, DB_NAME: 'contest_live' }), /explicit/);
});

test('native exit zero without the dedicated verified marker is failure', () => {
  const marker = 'synthetic-only-marker';
  assert.equal(workerOutcome({ code: 0, output: 'native migration apparently complete\n' }, marker).status, 'failed');
  assert.equal(workerOutcome({ code: 0, output: '{"migrationWorkerMarker":"another-marker","status":"verified"}\n' }, marker).status, 'failed');
  const completion = { migrationWorkerMarker: marker, status: 'verified', expectedMigrationModules: 15, verifiedMigrationModules: 15, enabledCustomExtensions: 4, counts: { riskyLegacyShipments: 0 } };
  assert.equal(workerOutcome({ code: 0, output: `${JSON.stringify(completion)}\n` }, marker).status, 'verified');
  assert.equal(workerOutcome({ code: 1, output: `${JSON.stringify(completion)}\n` }, marker).status, 'failed');
  assert.throws(() => workerOutcome({ code: 0, output: JSON.stringify({ ...completion, verifiedMigrationModules: 14 }) }, marker), /incomplete/);
});

test('preflight shipment blocking is distinguishable from a partial native migration', () => {
  const marker = 'synthetic-only-marker';
  const blocked = workerOutcome({ code: 2, output: JSON.stringify({ migrationWorkerMarker: marker, status: 'blocked', reason: 'legacy-pending-shipment-backfill-risk', counts: { riskyLegacyShipments: 1 }, needsFreshRestore: false }) }, marker);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.counts.riskyLegacyShipments, 1);
  assert.equal(blocked.needsFreshRestore, false);
  const failed = workerOutcome({ code: 0, output: '' }, marker);
  assert.equal(failed.needsFreshRestore, true);
});

test('module versions compare semantically and missing or older modules fail verification', () => {
  assert.deepEqual(sortVersions(['1.0.10', '1.0.9', '1.0.2']), ['1.0.2', '1.0.9', '1.0.10']);
  const expected = [{ module: 'checkout', version: '1.0.10' }, { module: 'bank-transfer', version: '1.0.1' }];
  assert.deepEqual(verifyInstalledVersions(expected, [{ module: 'checkout', version: '1.0.9' }]), ['checkout', 'bank-transfer']);
  assert.deepEqual(verifyInstalledVersions(expected, expected), []);
});

test('only pre-shipped legacy rows at risk of native backfill block migration', () => {
  const orders = [{ order_id: 1, shipment_status: 'shipped' }, { order_id: 2, shipment_status: 'pending' }, { order_id: 3, shipment_status: 'processing' }];
  assert.deepEqual(shippingRiskCounts(orders, [{ shipment_order_id: 1 }], '1.0.1'), { pendingOrders: 2, riskyLegacyShipments: 0 });
  assert.equal(shippingRiskCounts(orders, [{ shipment_order_id: 2 }], '1.0.1').riskyLegacyShipments, 1);
  assert.equal(shippingRiskCounts(orders, [{ shipment_order_id: 3 }], '1.0.1').riskyLegacyShipments, 1);
  assert.equal(shippingRiskCounts(orders, [{ shipment_order_id: 2 }], '1.0.3').riskyLegacyShipments, 0);
  assert.equal(shippingRiskCounts([{ order_id: 1, shipment_status: null }], [{ shipment_order_id: 1 }], null).riskyLegacyShipments, 1);
});

test('environment file is explicit and no default .env argument is introduced', () => {
  assert.equal(parseMigrationArguments([]).envFile, undefined);
  assert.equal(parseMigrationArguments(['--env-file', 'private/test-db.env']).envFile, 'private/test-db.env');
  assert.throws(() => parseMigrationArguments(['--env-file']), /explicit/);
});
