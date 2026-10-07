import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedPreviewRequest, createPreviewServer } from '../../deployment/preview-proxy.mjs';

test('preview rejects private routes, mutations, traversal and remote image sources', () => {
  for (const path of ['/admin', '/account', '/payment/opaque-id', '/api/graphql', '/login', '/dresses?email=x', '/assets/../admin', '/eHot/%2fadmin', '/images?src=https://example.com/a.jpg', '/images?src=/assets/a.jpg&url=https://example.com']) {
    assert.equal(allowedPreviewRequest('GET', new URL(path, 'http://127.0.0.1:3000')), false, path);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(allowedPreviewRequest(method, new URL('http://127.0.0.1:3000/')), false);
  assert.equal(allowedPreviewRequest('GET', new URL('http://127.0.0.1:3000/dresses/l1001')), true);
});

test('proxy cannot forward authentication or receiving cookies', async () => {
  let forwarded;
  const server = createPreviewServer({ fetchImpl: async (url, init) => { forwarded = init; return new Response('<h1>SHUSHA</h1>', { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'session=secret' } }); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { Cookie: 'customer=secret', Authorization: 'Bearer secret' } });
    assert.equal(result.status, 200); assert.equal(forwarded.headers, undefined); assert.equal(forwarded.body, undefined);
    assert.equal(result.headers.get('set-cookie'), null); assert.match(result.headers.get('x-robots-tag'), /noindex/);
    assert.equal(await result.text(), '<h1>SHUSHA</h1>');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
