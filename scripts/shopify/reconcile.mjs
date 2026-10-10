import { pathToFileURL } from 'node:url';
import { runBridgeReconcile } from '../../extensions/shopify-bridge/src/services/worker.js';

/** A read-only aggregate view is the default; --apply runs the guarded gap fill. */
export async function reconcile(runtime, { apply = false, env = process.env } = {}) {
  if (apply) return runBridgeReconcile(runtime, env);
  const counts = (await runtime.pool.query(`SELECT
    (SELECT COUNT(*) FROM shusha_bridge_inventory)::int AS shared_skus,
    (SELECT COUNT(*) FROM shusha_bridge_inventory WHERE frozen)::int AS frozen_skus,
    (SELECT COUNT(*) FROM shusha_bridge_outbox WHERE state<>'applied')::int AS unresolved_intents,
    (SELECT COUNT(*) FROM shusha_bridge_inbox WHERE state<>'processed')::int AS unresolved_deliveries,
    (SELECT COUNT(*) FROM shusha_bridge_orders WHERE platform='shopify')::int AS shopify_orders`)).rows[0];
  return { status: 'dry-run', remoteWrites: false, inventoryReset: false, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some((argument) => !['--apply'].includes(argument))) throw new Error('Only --apply is accepted');
  const { bridgeRuntime } = await import('../../extensions/shopify-bridge/dist/services/runtime.js');
  const runtime = bridgeRuntime();
  try {
    console.log(JSON.stringify(await reconcile(runtime, { apply: process.argv.includes('--apply') })));
  } catch (_) {
    console.error(JSON.stringify({ status: 'failed', code: 'SHOPIFY_RECONCILE_REQUIRES_REVIEW' })); process.exitCode = 1;
  } finally { await runtime.pool.end(); }
}
