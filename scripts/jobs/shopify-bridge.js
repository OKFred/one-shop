import { bridgeRuntime } from '../../extensions/shopify-bridge/dist/services/runtime.js';
import { runBridgeMinute } from '../../extensions/shopify-bridge/dist/services/worker.js';

export default async () => {
  if (process.env.SHOPIFY_BRIDGE_ENABLED !== 'true') return { status: 'disabled' };
  return runBridgeMinute(bridgeRuntime());
};
