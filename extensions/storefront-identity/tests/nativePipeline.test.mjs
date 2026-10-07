import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const native = path.join(root, 'packages/evershop/dist');
const nativeImport = file => import(pathToFileURL(path.join(native, file)).href);

test('native v2 pipeline retains the legacy redirect before auth and executes it on a prior 404', async () => {
  const { getCoreModules } = await nativeImport('bin/lib/loadModules.js');
  const { getModuleMiddlewares } = await nativeImport('lib/middleware/index.js');
  const { loadModuleRoutes } = await nativeImport('lib/router/loadModuleRoutes.js');
  const { Handler } = await nativeImport('lib/middleware/Handler.js');
  const { getRoutes } = await nativeImport('lib/router/Router.js');
  for (const module of getCoreModules()) { getModuleMiddlewares(module.path); loadModuleRoutes(module.path); }
  getModuleMiddlewares(path.join(root, 'extensions/storefront-identity/src'));
  const route = getRoutes().find(value => value.id === 'notFound');
  assert(route, 'native notFound route exists');
  const pipeline = Handler.getMiddlewareByRoute(route);
  const context = pipeline.findIndex(value => value.id === 'context');
  const redirect = pipeline.findIndex(value => value.id === 'shushaLegacyRedirect');
  const auth = pipeline.findIndex(value => value.id === 'auth');
  assert(context !== -1 && redirect > context && auth > redirect, 'redirect survives actual dependency filtering between context and auth');
  const { pool } = await import('@evershop/evershop/lib/postgres');
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, parameters) => { calls.push({ sql, parameters }); return { rows: [{ target_path: '/dresses' }] }; };
  const response = { statusCode: 404, debugMiddlewares: [], redirect(status, location) { this.statusCode = status; calls.push({ status, location }); } };
  try {
    await pipeline[redirect].middleware({ method: 'GET', path: '/old-category', originalUrl: '/old-category?empty=&x=one&x=two', currentRoute: route }, response, () => { throw new Error('A sent 301 must not continue into the 404 renderer'); });
    assert.equal(response.statusCode, 301);
    assert.deepEqual(calls[0].parameters, ['/old-category']);
    assert.deepEqual(calls[1], { status: 301, location: '/dresses?empty=&x=one&x=two' });
    const cmsRoute = getRoutes().find(value => value.id === 'cmsPageView');
    assert.equal(cmsRoute.path, '/page/:url_key', 'native CMS exposes the old route');
    const cmsPipeline = Handler.getMiddlewareByRoute(cmsRoute);
    const cmsRedirect = cmsPipeline.find(value => value.id === 'shushaLegacyRedirect');
    assert(cmsRedirect, 'fixed aliases execute even when the native CMS route already matched');
    calls.length = 0;
    await cmsRedirect.middleware({ method: 'GET', path: '/page/how-to-order', originalUrl: '/page/how-to-order?empty=&x=one&x=two&literal=%2520', currentRoute: cmsRoute }, response, () => { throw new Error('CMS alias must not continue into native query-dropping redirect'); });
    assert.deepEqual(calls, [{ status: 301, location: '/how-to-order?empty=&x=one&x=two&literal=%2520' }]);
  } finally { pool.query = originalQuery; await pool.end(); }
});
