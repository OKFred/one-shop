// Temporary catalog-only visual preview. Never forward identities or mutations.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function allowedPreviewRequest(method, url) {
  if (!['GET', 'HEAD'].includes(method)) return false;
  if (/[\\%]/.test(url.pathname)) return false;
  if (url.pathname === '/' || /^\/(dresses|pants|tops)(\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(url.pathname)) return !url.search;
  if (/^\/(assets|eHot)\/[a-zA-Z0-9_./-]+$/.test(url.pathname)) return !url.search;
  if (url.pathname === '/images') {
    const source = url.searchParams.get('src') || '';
    return /^\/assets\/[a-zA-Z0-9_./-]+$/.test(source) && !source.includes('..') &&
      [...url.searchParams.keys()].every(key => ['src', 'w', 'h', 'q', 'width', 'height', 'quality'].includes(key));
  }
  return false;
}

export function createPreviewServer({ upstream = 'http://127.0.0.1:3000', fetchImpl = fetch } = {}) {
  const origin = new URL(upstream);
  if (origin.origin !== upstream || origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw new Error('Preview upstream must be loopback');
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "form-action 'none'; base-uri 'none'");
    try {
      const url = new URL(request.url, upstream);
      if (url.origin !== upstream || !allowedPreviewRequest(request.method, url)) {
        response.writeHead(403); response.end('Catalog-only preview'); return;
      }
      // Cookie, Authorization, forwarded headers and request bodies never leave
      // this boundary. Only anonymous public SSR and local assets are visible.
      const result = await fetchImpl(url, { method: request.method, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (result.status !== 200) { await result.body?.cancel(); response.writeHead(502); response.end('Preview unavailable'); return; }
      response.setHeader('Content-Type', result.headers.get('content-type') || 'application/octet-stream');
      response.writeHead(200);
      if (request.method === 'HEAD') { await result.body?.cancel(); response.end(); }
      else response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(502); response.end('Preview unavailable'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createPreviewServer().listen(3011, '0.0.0.0', () => console.log('Catalog-only preview ready'));
}
