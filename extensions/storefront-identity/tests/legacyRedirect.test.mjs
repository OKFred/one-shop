import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyRedirectHandler, isSafeTarget, SELECT_LEGACY_PATH } from '../src/services/legacyRedirect.js';

function harness({ rows = [], queryError, request = {} } = {}) {
  const calls = { query: [], next: [], redirects: [] };
  const handler = createLegacyRedirectHandler({
    query: async (...args) => {
      calls.query.push(args);
      if (queryError) throw queryError;
      return { rows };
    }
  });
  const req = {
    method: 'GET',
    path: '/fred-dresses/old-dress',
    originalUrl: '/fred-dresses/old-dress',
    currentRoute: { id: 'notFound' },
    ...request
  };
  const res = {
    statusCode: 404,
    redirect(status, location) {
      this.statusCode = status;
      calls.redirects.push({ status, location });
    }
  };
  return {
    handler,
    calls,
    res,
    run: () => handler(req, res, (...args) => calls.next.push(args))
  };
}

test('native v2 handler has three arguments and replaces a prior 404 with exact 301', async () => {
  const h = harness({ rows: [{ target_path: '/dresses/new-dress' }] });
  assert.equal(h.handler.length, 3);
  await h.run();
  assert.deepEqual(h.calls.query, [[SELECT_LEGACY_PATH, ['/fred-dresses/old-dress']]]);
  assert.equal(h.res.statusCode, 301);
  assert.deepEqual(h.calls.redirects, [{ status: 301, location: '/dresses/new-dress' }]);
  assert.deepEqual(h.calls.next, []);
});

test('raw query order, duplicates and percent encoding are retained verbatim', async () => {
  const suffix = '?utm_source=A%2FB&size=M&size=L&empty=&literal=%2520';
  const h = harness({
    rows: [{ target_path: '/dresses/new-dress' }],
    request: { originalUrl: '/fred-dresses/old-dress' + suffix }
  });
  await h.run();
  assert.equal(h.calls.redirects[0].location, '/dresses/new-dress' + suffix);
});

test('lookup removes one trailing slash while preserving encoded spelling', async () => {
  const h = harness({ request: { path: '/fred-dresses/old%20dress/' } });
  await h.run();
  assert.deepEqual(h.calls.query[0][1], ['/fred-dresses/old%20dress']);
  assert.deepEqual(h.calls.next, [[]]);
  assert.deepEqual(h.calls.redirects, []);
  assert.equal(h.res.statusCode, 404);
});

test('old category trailing slash redirects to the canonical new category', async () => {
  const h = harness({
    rows: [{ target_path: '/dresses' }],
    request: { path: '/fred-dresses/', originalUrl: '/fred-dresses/?utm_source=A%2FB&x=1&x=2' }
  });
  await h.run();
  assert.deepEqual(h.calls.query[0][1], ['/fred-dresses']);
  assert.deepEqual(h.calls.redirects, [{ status: 301, location: '/dresses?utm_source=A%2FB&x=1&x=2' }]);
  assert.deepEqual(h.calls.next, []);
});

test('old product trailing slash redirects to the canonical new product', async () => {
  const h = harness({
    rows: [{ target_path: '/dresses/l1379' }],
    request: {
      path: '/fred-dresses/fred-suusha-l1379/',
      originalUrl: '/fred-dresses/fred-suusha-l1379/?size=M&size=L&empty=&literal=%2520'
    }
  });
  await h.run();
  assert.deepEqual(h.calls.query[0][1], ['/fred-dresses/fred-suusha-l1379']);
  assert.deepEqual(h.calls.redirects, [{ status: 301, location: '/dresses/l1379?size=M&size=L&empty=&literal=%2520' }]);
  assert.deepEqual(h.calls.next, []);
});

test('new paths without a legacy alias fall through with or without trailing slash', async () => {
  for (const requestPath of ['/dresses', '/dresses/', '/dresses/l1379', '/dresses/l1379/']) {
    const h = harness({ request: { path: requestPath, originalUrl: requestPath } });
    h.res.statusCode = 200;
    await h.run();
    assert.deepEqual(h.calls.next, [[]], requestPath);
    assert.deepEqual(h.calls.redirects, []);
    assert.equal(h.res.statusCode, 200);
  }
});

test('root, case, encoded and internal slashes remain intact; only one final slash is removed', async () => {
  for (const [requestPath, expectedLookup] of [
    ['/', '/'],
    ['/FRED-dresses/Old%2Fdress/', '/FRED-dresses/Old%2Fdress'],
    ['/fred-dresses/old%2F', '/fred-dresses/old%2F'],
    ['/fred-dresses//old-dress/', '/fred-dresses//old-dress'],
    ['/fred-dresses//', '/fred-dresses/']
  ]) {
    const h = harness({ request: { path: requestPath, originalUrl: requestPath } });
    await h.run();
    assert.deepEqual(h.calls.query[0][1], [expectedLookup], requestPath);
    assert.deepEqual(h.calls.next, [[]]);
  }
});

test('HEAD can redirect without calling next', async () => {
  const h = harness({ rows: [{ target_path: '/dresses/new-dress' }], request: { method: 'HEAD' } });
  await h.run();
  assert.equal(h.calls.redirects[0].status, 301);
  assert.deepEqual(h.calls.next, []);
});

test('POST and admin, API and static requests never query the ledger', async () => {
  for (const request of [
    { method: 'POST' },
    { currentRoute: { isAdmin: true } },
    { currentRoute: { isApi: true } },
    { path: '/admin/orders' },
    { path: '/api/products' },
    { path: '/graphql' },
    { path: '/assets/fred-edit/image.webp' },
    { path: '/media/catalog/image.webp' },
    { path: '/public/bundle.js' },
    { path: '/eHot/manifest' },
    { path: '/logo.svg' },
    { path: '/product.css' },
    { path: '/logo.svg/' }
  ]) {
    const h = harness({ request });
    await h.run();
    assert.deepEqual(h.calls.query, [], JSON.stringify(request));
    assert.deepEqual(h.calls.next, [[]]);
  }
});

test('missing optional ledger falls through; real database errors propagate once', async () => {
  const missing = harness({ queryError: { code: '42P01' } });
  await missing.run();
  assert.deepEqual(missing.calls.next, [[]]);
  const failure = new Error('database unavailable');
  const failed = harness({ queryError: failure });
  await failed.run();
  assert.deepEqual(failed.calls.next, [[failure]]);
  assert.deepEqual(failed.calls.redirects, []);
});

test('unsafe and self-referencing targets cannot create redirects', async () => {
  const targets = [
    undefined, null, '', 'https://example.com/', '//example.com/',
    '/\\example.com/', '/%2Fexample.com/', '/%5Cexample.com/',
    '/dresses?price=1', '/dresses#fragment', '/dresses\r\nX-Test: bad',
    '/dresses%0d%0aX-Test', '/dresses bad', '/bad%',
    '/fred-dresses/old-dress', '/admin', '/api/products', '/assets/picture.webp'
  ];
  for (const target_path of targets) {
    const h = harness({ rows: [{ target_path }] });
    await h.run();
    assert.deepEqual(h.calls.redirects, [], String(target_path));
    assert.deepEqual(h.calls.next, [[]]);
  }
  assert.equal(isSafeTarget('/dresses/new-dress', '/fred-dresses/old-dress'), true);
});

test('awaits the database before redirecting or continuing', async () => {
  let resolveQuery;
  const calls = [];
  const handler = createLegacyRedirectHandler({
    query: () => new Promise((resolve) => { resolveQuery = resolve; })
  });
  const pending = handler(
    { method: 'GET', path: '/old', originalUrl: '/old?' },
    { redirect: (status, location) => calls.push([status, location]) },
    [],
    () => calls.push('next')
  );
  assert.deepEqual(calls, []);
  resolveQuery({ rows: [{ target_path: '/new' }] });
  await pending;
  assert.deepEqual(calls, [[301, '/new?']]);
});
