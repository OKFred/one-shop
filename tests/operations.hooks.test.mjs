import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from '@swc/core';

const read = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');
const typescript = (source) => transformSync(source, { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'es6' } }).code;

async function nativeHooks() {
  const utility = typescript(await read('../packages/evershop/src/lib/util/hookable.ts'));
  const hooks = await import(`data:text/javascript;base64,${Buffer.from(utility).toString('base64')}`);
  hooks.clearHooks();
  const checkout = typescript(await read('../packages/evershop/src/modules/checkout/services/orderCreator.ts'));
  const cancel = typescript(await read('../packages/evershop/src/modules/oms/services/cancelOrder.ts'));
  const functions = {};
  for (const [name, source] of [
    ['hookBeforeSaveOrderItems', checkout], ['hookAfterSaveOrderItems', checkout],
    ['hookBeforeUpdatePaymentStatusToCancel', cancel], ['hookAfterReStockAfterCancel', cancel]
  ]) {
    // Execute the actual public registration function, rather than recreating
    // its callback name, position or priority in the test.
    const definition = source.match(new RegExp(`export function ${name}\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(definition, `The upstream hook export ${name} must retain its reviewed function contract`);
    functions[name] = new Function('hookBefore', 'hookAfter', `return function ${name}(${definition[1]}) {${definition[2]}}`)(hooks.hookBefore, hooks.hookAfter);
  }
  const checkoutPublic = await read('../packages/evershop/src/modules/checkout/services/index.ts');
  const omsPublic = await read('../packages/evershop/src/modules/oms/services/index.ts');
  assert.match(checkoutPublic, /export \* from '\.\/orderCreator\.js'/);
  assert.match(omsPublic, /export\s*\{[^}]*hookBeforeUpdatePaymentStatusToCancel[^}]*hookAfterReStockAfterCancel[^}]*\}\s*from '\.\/cancelOrder\.js'/);
  return { hooks, functions };
}

async function bootstrap(env) {
  const { hooks, functions } = await nativeHooks();
  const source = await read('../extensions/shopify-bridge/src/bootstrap.js');
  assert.match(source, /from '@evershop\/evershop\/lib\/cronjob'/);
  assert.doesNotMatch(source, /system\.jobs|node-cron|child_process|setInterval/);
  const calls = []; const jobs = [];
  const inventory = Object.fromEntries(['beforeNativeOrder', 'recordNativeOrder', 'beforeNativeCancel', 'recordNativeCancel'].map((name) =>
    [name, async (...args) => { calls.push({ name, args }); }]));
  const context = { path, process: { env, cwd: () => '/synthetic/store' }, registerJob: (job) => jobs.push(job), ...functions, ...inventory };
  // Only external imports are injected. The saved bootstrap body itself is
  // executed unchanged, including all gates, argument adapters and priorities.
  vm.runInNewContext(source.replace(/^import .*;\r?$/gm, '').replace('export default () =>', 'bootstrap = () =>'), context);
  context.bootstrap();
  return { hooks, calls, jobs };
}

test('disabled bridge installs neither order observers nor another scheduler', async () => {
  const { hooks, jobs } = await bootstrap({ SHOPIFY_BRIDGE_ENABLED: 'false' });
  assert.equal(jobs.length, 0); assert.equal(hooks.getHooks().beforeHooks.size, 0); assert.equal(hooks.getHooks().afterHooks.size, 0);
});

test('actual bootstrap and public native hooks preserve result positions and the original transaction connection', async () => {
  const { hooks, calls, jobs } = await bootstrap({ SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_SHARED_CAPACITY_ENABLED: 'true' });
  const connection = { INTRANSACTION: true }; const cart = { nativeCart: true };
  async function saveOrderItems(receivedCart, orderId, receivedConnection) {
    assert.equal(receivedCart, cart); assert.equal(receivedConnection, connection);
    assert.equal(orderId, 17); return ['native-items-result'];
  }
  async function updatePaymentStatusToCancel(orderId, receivedConnection) { assert.equal(receivedConnection, connection); assert.equal(orderId, 17); }
  async function reStockAfterCancel(orderId, receivedConnection) { assert.equal(receivedConnection, connection); assert.equal(orderId, 17); return 'native-restock-result'; }
  await hooks.hookable(saveOrderItems, { cart })(cart, 17, connection);
  await hooks.hookable(updatePaymentStatusToCancel, {})(17, connection);
  await hooks.hookable(reStockAfterCancel, {})(17, connection);
  assert.deepEqual(calls.map((call) => call.name), ['beforeNativeOrder', 'recordNativeOrder', 'beforeNativeCancel', 'recordNativeCancel']);
  assert.equal(calls[0].args[0], connection); assert.equal(calls[0].args[1], cart);
  for (const call of calls.slice(1)) { assert.equal(call.args[0], connection); assert.equal(call.args[1], 17); }
  assert.equal(hooks.getHooks().beforeHooks.get('saveOrderItems')[0].priority, 0);
  assert.equal(hooks.getHooks().afterHooks.get('saveOrderItems')[0].priority, 900);
  assert.equal(jobs.length, 0);
});

test('two bridge jobs register with the existing native cron and require Shanghai time', async () => {
  const env = { SHOPIFY_BRIDGE_ENABLED: 'true', SHOPIFY_BRIDGE_JOBS_ENABLED: 'true', TZ: 'Asia/Shanghai', SHUSHA_APP_DIR: '/synthetic/store' };
  const { jobs, hooks } = await bootstrap(env);
  assert.deepEqual(jobs.map((job) => [job.name, job.schedule]), [['shopify-bridge', '* * * * *'], ['shopify-reconcile', '*/15 * * * *']]);
  assert.equal(jobs[0].resolve, path.resolve('/synthetic/store', 'scripts/jobs/shopify-bridge.js'));
  assert.equal(jobs[1].resolve, path.resolve('/synthetic/store', 'scripts/jobs/shopify-reconcile.js'));
  assert.ok(jobs.every((job) => job.enabled === true)); assert.equal(hooks.getHooks().beforeHooks.size, 0);
  await assert.rejects(bootstrap({ ...env, TZ: 'UTC' }), /Asia\/Shanghai/);
});
