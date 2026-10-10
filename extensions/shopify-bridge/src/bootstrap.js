import path from 'node:path';
import { registerJob } from '@evershop/evershop/lib/cronjob';
import { hookBeforeSaveOrderItems, hookAfterSaveOrderItems } from '@evershop/evershop/checkout/services';
import { hookBeforeUpdatePaymentStatusToCancel, hookAfterReStockAfterCancel } from '@evershop/evershop/oms/services';
import { beforeNativeOrder, recordNativeOrder, beforeNativeCancel, recordNativeCancel } from './services/inventory.js';

// Register with the existing native process; do not create another scheduler.
export default () => {
  if (process.env.SHOPIFY_BRIDGE_ENABLED !== 'true') return;
  if (process.env.SHOPIFY_BRIDGE_JOBS_ENABLED === 'true') {
    if (process.env.TZ !== 'Asia/Shanghai') throw new Error('Shopify bridge jobs require TZ=Asia/Shanghai');
    const appDir = process.env.SHUSHA_APP_DIR || process.cwd();
    registerJob({name:'shopify-bridge',resolve:path.resolve(appDir,'scripts/jobs/shopify-bridge.js'),schedule:'* * * * *',enabled:true});
    registerJob({name:'shopify-reconcile',resolve:path.resolve(appDir,'scripts/jobs/shopify-reconcile.js'),schedule:'*/15 * * * *',enabled:true});
  }
  if (process.env.SHOPIFY_SHARED_CAPACITY_ENABLED !== 'true') return;
  hookBeforeSaveOrderItems(async (cart,_orderId,connection) => beforeNativeOrder(connection,cart),0);
  hookAfterSaveOrderItems(async (_result,_cart,orderId,connection) => recordNativeOrder(connection,orderId),900);
  hookBeforeUpdatePaymentStatusToCancel(async (orderId,connection) => beforeNativeCancel(connection,orderId),0);
  hookAfterReStockAfterCancel(async (_result,orderId,connection) => recordNativeCancel(connection,orderId),900);
};
