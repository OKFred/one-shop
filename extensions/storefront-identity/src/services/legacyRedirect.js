const SELECT_LEGACY_PATH =
  'SELECT target_path FROM public.shusha_legacy_path WHERE request_path = $1';

const RESERVED_PREFIX = /^\/(?:admin|api|graphql|assets|media|public|eHot)(?:\/|$)/i;
const STATIC_EXTENSION = /\.(?:css|js|mjs|map|json|png|jpe?g|webp|gif|svg|ico|avif|woff2?|ttf|eot|mp4|webm)(?:$)/i;

function isSafeTarget(target, requestPath) {
  if (typeof target !== 'string' || target === requestPath) return false;
  // The ledger stores a path, never a host, query string or fragment.
  if (!target.startsWith('/') || target.startsWith('//')) return false;
  if (/[\\?#\s\u0000-\u001f\u007f]/u.test(target)) return false;

  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch (_) {
    return false;
  }
  if (decoded.startsWith('//') || /[\\?#\s\u0000-\u001f\u007f]/u.test(decoded)) {
    return false;
  }
  return !RESERVED_PREFIX.test(decoded);
}

function rawQuery(request) {
  const originalUrl = request.originalUrl || request.url || '';
  const queryStart = originalUrl.indexOf('?');
  return queryStart === -1 ? '' : originalUrl.slice(queryStart);
}

function createLegacyRedirectHandler({ query }) {
  if (typeof query !== 'function') {
    throw new TypeError('A PostgreSQL query function is required');
  }

  // EverShop v2 awaits Express-style three-argument middleware.
  return async function shushaLegacyRedirect(request, response, next) {
    const requestPath = request.path;
    // Native storefront rewrites accept a single trailing slash. Preserve every
    // other byte, including encoded slashes, case and internal/repeated slashes.
    const lookupPath = typeof requestPath === 'string' && requestPath.length > 1 && requestPath.endsWith('/')
      ? requestPath.slice(0, -1)
      : requestPath;
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      request.currentRoute?.isAdmin === true ||
      request.currentRoute?.isApi === true ||
      typeof requestPath !== 'string' ||
      !requestPath.startsWith('/') ||
      RESERVED_PREFIX.test(requestPath) ||
      STATIC_EXTENSION.test(lookupPath)
    ) {
      next();
      return;
    }

    let result;
    try {
      // The ledger retains only the exact canonical old paths.
      result = await query(SELECT_LEGACY_PATH, [lookupPath]);
    } catch (error) {
      // Before the optional ledger is installed, the extension has no redirects.
      // Other database errors must reach EverShop's normal error handler.
      if (error.code === '42P01') next();
      else next(error);
      return;
    }

    const target = result.rows[0]?.target_path;
    if (!isSafeTarget(target, lookupPath)) {
      next();
      return;
    }

    response.redirect(301, target + rawQuery(request));
  };
}

export { createLegacyRedirectHandler, isSafeTarget, SELECT_LEGACY_PATH };
