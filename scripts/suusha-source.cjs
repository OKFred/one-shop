#!/usr/bin/env node
'use strict';

// Public catalog/material adapter. Never uses browser cookies or account actions.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = process.cwd();
const SITE = 'https://wh.suusha.com/';
const PRIVATE_DATA = path.resolve(process.env.PRIVATE_DATA_DIR || path.join(ROOT, 'data'));
const LIBRARY = path.resolve(process.env.MATERIAL_LIBRARY_DIR || path.join(PRIVATE_DATA, 'material-library'));
const MEDIA = path.resolve(process.env.MATERIAL_MEDIA_DIR || path.join(ROOT, 'media/source-library'));
function mediaFile(localPath) {
  assert(/^media\/source-library\/[a-f0-9]{64}\.(?:webp|jpe?g|png)$/i.test(localPath), 'Invalid indexed material image path');
  return path.join(MEDIA, path.basename(localPath));
}
const PUBLIC_ACTIONS = new Set(['categories', 'items', 'suggest', 'product', 'variant']);
const PUBLIC_HOSTS = new Set(['wh.suusha.com', 'cdn.suusha.com', 'app.suusha.com', 'suusha.com']);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runId = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
const safeRelative = (filename) => path.relative(ROOT, filename).split(path.sep).join('/');

async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function atomic(filename, bytes, mode = 0o600) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
  try { await fs.rename(temporary, filename); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}
async function json(filename, value) { await atomic(filename, `${JSON.stringify(value, null, 2)}\n`); }
function urlAllowed(value) {
  const url = new URL(value, SITE);
  assert(url.protocol === 'https:' && PUBLIC_HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443'), `Public URL is outside the allowed source hosts: ${url.origin}`);
  return url;
}
function sourceImageUrl(value) {
  const url = new URL(value, SITE);
  assert(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'), 'Source gallery contains an invalid image URL');
  // Preserve publicly returned external URLs as evidence; request() still refuses unreviewed hosts.
  return url.href;
}
function money(lkr, rate) {
  if (lkr === null || lkr === undefined || lkr === '') return null;
  const value = Number(lkr);
  assert(Number.isFinite(value) && value >= 0, 'Invalid public source price');
  const displayUsd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(value / rate);
  return { lkr: value, usd: Number(displayUsd), displayUsd };
}
function prices(row, rate) {
  return {
    wholesale: money(row.price1, rate), resale: money(row.price2, rate),
    wholesaleOriginal: money(row.wholesale_ori, rate), resaleOriginal: money(row.resale_ori, rate)
  };
}
async function mapLimit(items, concurrency, action) {
  let cursor = 0; let failure;
  const output = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !failure) {
      const index = cursor++;
      try { output[index] = await action(items[index], index); } catch (error) { failure = failure || error; }
    }
  }));
  if (failure) throw failure;
  return output;
}
function argumentsFor(argv) {
  const options = { newArrivals: 0, maxPages: 1, concurrency: 3, maxRequests: 600, maxFiles: 300, maxBytes: 64 * 1024 * 1024, maxAgeHours: 26, apply: false };
  const modes = ['--capture', '--download', '--library-report', '--sync-prices'];
  const numbers = { '--new-arrivals': 'newArrivals', '--max-pages': 'maxPages', '--concurrency': 'concurrency', '--max-requests': 'maxRequests', '--max-files': 'maxFiles', '--max-bytes': 'maxBytes', '--max-age-hours': 'maxAgeHours' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (modes.includes(arg)) { assert(!options.mode, 'Choose exactly one mode'); options.mode = arg.slice(2); }
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--download-source-ids') {
      const value = argv[++i];
      assert(typeof value === 'string' && value.length > 0, '--download-source-ids requires comma-separated exact source IDs');
      options.downloadSourceIds = value.split(',');
      assert(options.downloadSourceIds.length <= 24 && options.downloadSourceIds.every((sourceId) => /^L\d{3,8}$/.test(sourceId)) && new Set(options.downloadSourceIds).size === options.downloadSourceIds.length, 'Download source IDs must be unique exact L IDs, at most 24');
    }
    else if (numbers[arg]) { const value = Number(argv[++i]); assert(Number.isSafeInteger(value) && value >= 0, `Invalid value for ${arg}`); options[numbers[arg]] = value; }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  assert(options.help || options.mode, 'Choose --capture, --download, --library-report or --sync-prices');
  assert(options.newArrivals <= 24 && options.maxPages >= 1 && options.maxPages <= 3, 'Capture is limited to 24 new styles and at most 3 listing pages');
  assert(options.concurrency >= 1 && options.concurrency <= 3, 'Network concurrency must be 1-3');
  assert(options.maxRequests >= 1 && options.maxRequests <= 1000 && options.maxFiles <= 500 && options.maxBytes <= 128 * 1024 * 1024, 'Request/media limits exceed the bounded adapter maximum');
  assert(!options.apply || options.mode === 'sync-prices', '--apply is only supported with --sync-prices');
  assert(!options.downloadSourceIds || options.mode === 'download', '--download-source-ids is only supported with --download');
  assert(options.maxAgeHours >= 1 && options.maxAgeHours <= 48, 'Price snapshot age limit must be 1-48 hours');
  return options;
}
async function request(url, init = {}, maxBytes = 5 * 1024 * 1024) {
  let current = urlAllowed(url);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetch(current, { ...init, credentials: 'omit', redirect: 'manual', headers: { 'User-Agent': 'SHUSHA-Public-Catalog/1.0', ...init.headers }, signal: AbortSignal.timeout(25000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      assert(response.headers.get('location'), 'Redirect without a destination');
      current = urlAllowed(new URL(response.headers.get('location'), current));
      await response.body?.cancel();
      continue;
    }
    assert(response.status !== 401 && response.status !== 403, `Source requires authorization (${response.status}); stop without using cookies or credentials`);
    assert(response.ok, `Public source returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength)) assert(contentLength <= maxBytes, 'Source response exceeds the byte limit');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) { await response.body.cancel().catch(() => {}); throw new Error('Source response exceeds the byte limit'); } chunks.push(chunk); }
    return { status: response.status, url: current.href, contentType: response.headers.get('content-type'), bytes: Buffer.concat(chunks) };
  }
  throw new Error('Too many source redirects');
}
async function initialStoreMap() {
  const filename = path.join(LIBRARY, 'store-map.json');
  const existing = await readJson(filename, null);
  if (existing) return existing;
  const source = await readJson(path.join(PRIVATE_DATA, 'showcase.json'), { products: [] });
  const map = { schemaVersion: 1, mappings: source.products.map((product) => ({ storeSku: product.sku, storeUrlKey: product.url_key, sourceId: product.sourceId, sourceVariantSku: null, priceBasis: 'site-resale-display' })) };
  await json(filename, map);
  return map;
}
function productFingerprint(product) {
  return sha(JSON.stringify(product, (key, value) => ['capturedAt', 'evidence', 'publication', 'readiness', 'sourceReviewSha256'].includes(key) ? undefined : value));
}
function productReviewFingerprint(product) {
  // Price/stock changes do not invalidate a visual review; SKU, colors, sizes,
  // descriptions and gallery changes do. The captured full catalog hash stays
  // in publication.captureCatalogSha256 as an immutable audit reference.
  return sha(JSON.stringify({
    sourceId: product.sourceId, title: product.title,
    sourceCategoryId: product.sourceCategoryId, sourceCategoryName: product.sourceCategoryName,
    sourceCategoryNames: product.sourceCategoryNames, descriptionRaw: product.descriptionRaw,
    sourceBaseSkus: product.sourceBaseSkus, colors: product.colors, sizes: product.sizes,
    variants: product.variants.map((variant) => ({
      sourceSku: variant.sourceSku, colorId: variant.colorId, color: variant.color,
      sizeId: variant.sizeId, size: variant.size, gallery: variant.gallery,
      baseSkus: (variant.baseVariants || []).map((base) => base.sourceSku)
    })),
    sourceImages: product.sourceImages
  }));
}
function preserveReview(before, product) {
  product.sourceReviewSha256 = productReviewFingerprint(product);
  if (!before?.publication) return product;
  const same = before.publication.reviewedSourceSha256 === product.sourceReviewSha256;
  product.publication = same ? before.publication : {
    ...before.publication, ready: false, invalidatedAt: product.capturedAt,
    invalidationReason: 'Source SKU, color/size, description or gallery facts changed; review again',
    currentSourceSha256: product.sourceReviewSha256
  };
  if (same && before.publication.ready === true) {
    product.readiness = { ...product.readiness, level: 'source-material-reviewed', measurementChart: before.readiness?.measurementChart || 'unverified', imageContent: 'reviewed', categoryAndDescription: 'reviewed-with-recorded-omissions' };
  }
  return product;
}
async function capture(options) {
  const id = runId(); const directory = path.join(LIBRARY, 'snapshots', id);
  await fs.mkdir(directory, { recursive: true });
  const map = await initialStoreMap();
  const old = await readJson(path.join(LIBRARY, 'catalog.json'), { products: [] });
  const home = await request(SITE, {}, 1024 * 1024);
  await atomic(path.join(directory, 'homepage.html'), home.bytes);
  const html = home.bytes.toString('utf8');
  const links = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((match) => new URL(match[1], SITE));
  const scriptUrl = links.find((url) => url.hostname === 'wh.suusha.com' && /\/assets\/app\.js$/.test(url.pathname));
  assert(scriptUrl, 'Cannot discover the public catalog script from the source homepage');
  const script = await request(scriptUrl, {}, 1024 * 1024);
  await atomic(path.join(directory, 'app.js'), script.bytes);
  const js = script.bytes.toString('utf8');
  const apiMatch = js.match(/const\s+API\s*=\s*window\.BASE_URL\s*\+\s*['"]([^'"]+)['"]/);
  assert(apiMatch && apiMatch[1] === 'ajax.php', 'Public catalog API definition changed; review before continuing');
  assert(/prices are stored\/served in LKR/i.test(js), 'Cannot confirm the source API currency from its public script');
  const rates = js.match(/const\s+CUR_RATES\s*=\s*\{([^}]+)\}/);
  const usdRate = rates?.[1].match(/\bUSD\s*:\s*([0-9.]+)/);
  const rate = Number(usdRate?.[1]);
  assert(Number.isFinite(rate) && rate > 0, 'Cannot discover the source USD display conversion rate');
  const apiUrl = new URL(apiMatch[1], SITE).href;
  let requests = 0; const evidence = []; const capturedAt = new Date().toISOString();
  async function api(action, data = {}) {
    assert(PUBLIC_ACTIONS.has(action), 'This adapter only supports read-only catalog actions');
    assert(++requests <= options.maxRequests, 'Capture request limit reached; existing catalog was not replaced');
    const filename = `${String(requests).padStart(4, '0')}-${action}-${sha(JSON.stringify(data)).slice(0, 12)}.json`;
    await sleep(100);
    const response = await request(apiUrl, { method: 'POST', body: new URLSearchParams({ action, ...data }) }, 2 * 1024 * 1024);
    const body = JSON.parse(response.bytes.toString('utf8'));
    assert(body.status === 'success', `Public ${action} action failed; authorization is not attempted`);
    const entry = { action, params: data, status: response.status, sha256: sha(response.bytes), path: safeRelative(path.join(directory, filename)) };
    await atomic(path.join(directory, filename), response.bytes);
    evidence.push(entry);
    return { body, evidence: entry };
  }
  const categories = await api('categories');
  const listings = []; const pages = [];
  for (let page = 1; page <= options.maxPages; page++) {
    const response = await api('items', { category: '', upcoming: '0', sale: '0', page: String(page) });
    assert(Array.isArray(response.body.items), 'Listing response has no items array');
    listings.push(...response.body.items);
    pages.push({ page, count: response.body.items.length, hasMore: response.body.has_more, evidence: response.evidence });
    if (!response.body.has_more) break;
  }
  const byId = new Map();
  for (const item of listings) { if (/^L\d+$/.test(item.category_name || '') && !byId.has(item.category_name)) byId.set(item.category_name, item); }
  const requiredIds = [...new Set(map.mappings.map((item) => item.sourceId))];
  for (const sourceId of requiredIds) {
    if (byId.has(sourceId)) continue;
    const found = await api('suggest', { q: sourceId });
    const item = found.body.items?.find((row) => row.category_name === sourceId);
    assert(item, `Managed source ID ${sourceId} was not found; no removal or price update is inferred`);
    byId.set(sourceId, item);
  }
  const selectedIds = [...new Set([...requiredIds, ...[...byId.keys()].slice(0, options.newArrivals)])];
  assert(selectedIds.length <= requiredIds.length + 24, 'Selected style count exceeds the bounded scope');
  const products = await mapLimit(selectedIds, options.concurrency, async (sourceId) => {
    const listing = byId.get(sourceId);
    const detail = await api('product', { item_name: listing.item_name, color_id: String(listing.color_id) });
    const data = detail.body;
    assert(data.category_names?.includes(sourceId) || data.category_name === sourceId, `Product ownership changed for ${sourceId}`);
    assert(Array.isArray(data.colors) && Array.isArray(data.sizes) && Array.isArray(data.base_skus), 'Unexpected product color/size/SKU schema');
    const variants = []; const images = new Set(); const availableSizes = [];
    // Products run concurrently; each product's matrix remains sequential so total requests never exceed --concurrency.
    for (const color of data.colors) {
      const availability = await api('variant', { item_name: data.item_name, color_id: String(color.id), size_id: '0', sticker_id: '0', category_id: String(data.category_id) });
      assert(Array.isArray(availability.body.available_sizes), `Missing availability for ${sourceId}/${color.id}`);
      availableSizes.push({ colorId: color.id, sizes: availability.body.available_sizes, evidence: availability.evidence });
      for (const size of data.sizes) {
        const resolved = await api('variant', { item_name: data.item_name, color_id: String(color.id), size_id: String(size.id), sticker_id: '0', category_id: String(data.category_id) });
        const variant = resolved.body.variant;
        const flag = resolved.body.available_sizes?.find((row) => row.id === size.id);
        if (!variant || !(typeof variant.sku === 'string' && variant.sku)) {
          const gallery = (variant?.gallery || []).map(sourceImageUrl);
          for (const url of gallery) images.add(url);
          variants.push({ colorId: color.id, color: color.name, sizeId: size.id, size: size.name, available: flag?.available === true, availableQty: Number(variant?.available_qty || 0), resolved: false, sourceSku: null, gallery, evidence: resolved.evidence });
          continue;
        }
        const gallery = (variant.gallery || []).map(sourceImageUrl);
        for (const url of gallery) images.add(url);
        variants.push({
          sourceSku: variant.sku, displaySku: variant.display_sku || variant.sku,
          colorId: color.id, color: color.name, sizeId: size.id, size: size.name,
          available: flag?.available === true, availableQty: Number(variant.available_qty), resolved: true,
          prices: prices(variant, rate), gallery,
          baseVariants: (variant.base_variants || []).map((row) => ({ stockId: row.stock_id, sourceSku: row.sku, stockQty: Number(row.stock_qty), prices: prices(row, rate) })),
          evidence: resolved.evidence
        });
      }
    }
    let current = prices(listing, rate); let priceBasis = 'listing';
    if (!current.resale || !current.wholesale) {
      const available = variants.filter((row) => row.resolved && row.available && row.prices.resale && row.prices.wholesale);
      const unique = new Map(available.map((row) => [JSON.stringify(row.prices), row.prices]));
      current = unique.size === 1 ? [...unique.values()][0] : { wholesale: null, resale: null, wholesaleOriginal: null, resaleOriginal: null };
      priceBasis = unique.size === 1 ? 'all-available-variants-agree' : 'unresolved-without-listing';
    }
    return {
      sourceId, title: data.item_name, listingId: listing.id, sourceCategoryId: data.category_id,
      sourceCategoryName: data.category_name, sourceCategoryNames: data.category_names,
      capturedAt, sourceUrl: SITE, descriptionRaw: data.textbox_details || '',
      sourceCurrency: 'LKR', displayCurrency: 'USD', sourcePrices: current, priceBasis,
      sourcePriceUsd: current.resale?.usd ?? null, siteUsdDivisor: rate,
      sourceBaseSkus: data.base_skus, colors: data.colors, sizes: data.sizes, availableSizes, variants,
      sourceImages: [...images], sourceListingImage: listing.image_5 ? sourceImageUrl(listing.image_5) : null,
      readiness: { level: variants.some((variant) => variant.available && !variant.resolved) || !current.resale ? 'source-data-incomplete' : 'material-captured-review-required', colorSizeNames: 'source-reported', measurementChart: 'not-reviewed', merchantVariantMapping: 'not-published', reviewRequired: ['category-and-description', 'measurement-chart', 'image-content', 'merchant-variant-mapping', 'commercial-terms'] },
      evidence: { detail: detail.evidence }
    };
  });
  const previous = new Map(old.products.map((product) => [product.sourceId, product]));
  const changes = products.map((product) => {
    const before = previous.get(product.sourceId);
    preserveReview(before, product);
    return { sourceId: product.sourceId, status: !before ? 'added' : productFingerprint(before) === productFingerprint(product) ? 'unchanged' : 'changed', beforePriceUsd: before?.sourcePriceUsd ?? null, afterPriceUsd: product.sourcePriceUsd, priceChanged: Boolean(before && before.sourcePriceUsd !== product.sourcePriceUsd) };
  });
  for (const product of products) previous.set(product.sourceId, product);
  const manifest = {
    schemaVersion: 1, lastCaptureAt: capturedAt, runId: id,
    source: { siteUrl: SITE, apiUrl, scriptUrl: scriptUrl.href, scriptSha256: sha(script.bytes), currency: 'LKR', displayCurrency: 'USD', usdDivisor: rate, priceColumn: 'price2 / Resale', conversionPolicy: 'source-site-display-two-decimal-rounding', requestsWithoutCookiesOrCredentials: true },
    scope: { managedSourceIds: requiredIds, newArrivals: options.newArrivals, selectedSourceIds: selectedIds, pages, requestCount: requests, maxConcurrency: options.concurrency, scopeDoesNotDeleteMissingProducts: true },
    categories: categories.body.categories,
    products: [...previous.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)), changes,
    evidenceIndex: safeRelative(path.join(directory, 'index.json'))
  };
  const snapshot = { ...manifest, products };
  await json(path.join(directory, 'catalog.json'), snapshot);
  await json(path.join(directory, 'index.json'), { capturedAt, scriptSha256: sha(script.bytes), homepageSha256: sha(home.bytes), responseCount: evidence.length, responses: evidence.sort((a, b) => a.path.localeCompare(b.path)) });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await atomic(path.join(LIBRARY, 'catalog.json'), bytes);
  await json(path.join(LIBRARY, 'catalog.sha256.json'), { sha256: sha(bytes), path: 'data/material-library/catalog.json', capturedAt });
  await json(path.join(LIBRARY, 'latest-run.json'), { runId: id, capturedAt, selectedSourceIds: selectedIds, changes, snapshotDirectory: safeRelative(directory), requestCount: requests });
  return { mode: 'capture', runId: id, stylesCaptured: products.length, libraryStyles: manifest.products.length, variants: products.reduce((sum, product) => sum + product.variants.length, 0), sourceImages: new Set(products.flatMap((product) => product.sourceImages)).size, requestCount: requests, changes };
}
function imageDimensions(bytes) {
  if (bytes.subarray(0, 12).toString('ascii').startsWith('RIFF') && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.subarray(offset, offset + 4).toString('ascii'); const size = bytes.readUInt32LE(offset + 4); const data = offset + 8;
      if (type === 'VP8X' && size >= 10) return { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1 };
      if (type === 'VP8 ' && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) return { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
      if (type === 'VP8L' && size >= 5 && bytes[data] === 0x2f) { const n = bytes.readUInt32LE(data + 1); return { width: (n & 0x3fff) + 1, height: ((n >>> 14) & 0x3fff) + 1 }; }
      offset = data + size + (size % 2);
    }
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 0xff) continue; const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(offset);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      if (length < 2) break; offset += length;
    }
  }
  return null;
}
async function download(options) {
  const catalogBytes = await fs.readFile(path.join(LIBRARY, 'catalog.json'));
  const manifest = JSON.parse(catalogBytes);
  const integrity = await readJson(path.join(LIBRARY, 'catalog.sha256.json'));
  assert(integrity.sha256 === sha(catalogBytes), 'Catalog hash differs before download');
  const latest = options.downloadSourceIds ? { runId: manifest.runId, selectedSourceIds: options.downloadSourceIds } : await readJson(path.join(LIBRARY, 'latest-run.json'));
  const products = latest.selectedSourceIds.map((sourceId) => {
    const product = manifest.products.find((row) => row.sourceId === sourceId);
    assert(product, `Download source ID is absent from the captured catalog: ${sourceId}`);
    return product;
  });
  const urls = [...new Set(products.flatMap((product) => product.sourceImages))];
  const index = await readJson(path.join(LIBRARY, 'media-index.json'), { schemaVersion: 1, assets: [] });
  const cached = new Map(index.assets.map((asset) => [asset.sourceUrl, asset]));
  await fs.mkdir(MEDIA, { recursive: true });
  await atomic(path.join(MEDIA, '.gitignore'), '*\n!.gitignore\n');
  let downloaded = 0; let downloadedBytes = 0; let reused = 0; const failures = []; const skipped = [];
  // Sequential downloads make file/byte budgets deterministic and reduce source-server load.
  for (const sourceUrl of urls) {
    const previous = cached.get(sourceUrl);
    if (previous) {
      const filename = mediaFile(previous.localPath);
      assert(filename.startsWith(MEDIA + path.sep), 'Cached media path escaped the source library');
      try { const bytes = await fs.readFile(filename); if (sha(bytes) === previous.sha256) { reused++; continue; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (downloaded >= options.maxFiles || downloadedBytes >= options.maxBytes) { skipped.push(sourceUrl); continue; }
    try {
      await sleep(100);
      const response = await request(sourceUrl, {}, Math.min(5 * 1024 * 1024, options.maxBytes - downloadedBytes));
      assert(/^image\/(webp|jpeg|png)(?:;|$)/i.test(response.contentType || ''), 'Source media is not a supported image');
      const dimensions = imageDimensions(response.bytes);
      assert(dimensions && dimensions.width > 0 && dimensions.height > 0, 'Cannot validate source image dimensions');
      const digest = sha(response.bytes); const extension = /webp/i.test(response.contentType) ? '.webp' : /png/i.test(response.contentType) ? '.png' : '.jpg';
      assert(!previous || digest === previous.sha256, 'Source image bytes changed at the captured URL; review and recapture before replacing the indexed image');
      const filename = path.join(MEDIA, `${digest}${extension}`);
      await atomic(filename, response.bytes);
      const asset = { sourceUrl, finalUrl: response.url, localPath: `media/source-library/${path.basename(filename)}`, sha256: digest, bytes: response.bytes.length, contentType: response.contentType, ...dimensions, downloadedAt: new Date().toISOString() };
      cached.set(sourceUrl, asset); downloaded++; downloadedBytes += response.bytes.length;
      await json(path.join(LIBRARY, 'media-index.json'), { schemaVersion: 1, assets: [...cached.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl)) });
    } catch (error) { failures.push({ sourceUrl, reason: error.message }); if (/authorization|401|403/i.test(error.message)) throw error; }
  }
  const report = { schemaVersion: 1, finishedAt: new Date().toISOString(), runId: latest.runId, selectedSourceIds: latest.selectedSourceIds, styles: products.length, uniqueSourceImages: urls.length, downloaded, downloadedBytes, reused, skipped, failures, complete: skipped.length === 0 && failures.length === 0, limits: { maxFiles: options.maxFiles, maxBytes: options.maxBytes } };
  await json(path.join(LIBRARY, 'download-report.json'), report);
  return { mode: 'download', ...report };
}
async function report() {
  const manifest = await readJson(path.join(LIBRARY, 'catalog.json'));
  const media = await readJson(path.join(LIBRARY, 'media-index.json'), { assets: [] });
  const checks = await mapLimit(media.assets, 3, async (asset) => {
    const filename = mediaFile(asset.localPath);
    assert(filename.startsWith(MEDIA + path.sep), 'Report media path escaped the source library');
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes || sha(await fs.readFile(filename)) !== asset.sha256) return { sourceUrl: asset.sourceUrl, issue: 'local-file-size-type-or-hash-differs' };
      return { asset };
    } catch (error) { if (error.code === 'ENOENT') return { sourceUrl: asset.sourceUrl, issue: 'local-file-missing' }; throw error; }
  });
  const localAssets = checks.filter((item) => item.asset).map((item) => item.asset);
  const byUrl = new Map(localAssets.map((item) => [item.sourceUrl, item]));
  const products = manifest.products.map((product) => {
    const downloaded = product.sourceImages.map((url) => byUrl.get(url)).filter(Boolean);
    return { sourceId: product.sourceId, title: product.title, capturedAt: product.capturedAt, sourcePriceUsd: product.sourcePriceUsd, colorNames: product.colors.map((color) => color.name), sizeNames: product.sizes.map((size) => size.name), variantCount: product.variants.length, availableVariants: product.variants.filter((variant) => variant.available).length, sourceImages: product.sourceImages.length, downloadedImages: downloaded.length, downloadedBytes: downloaded.reduce((sum, item) => sum + item.bytes, 0), imagesComplete: downloaded.length === product.sourceImages.length, publicationReady: product.publication?.ready === true, reviewedAt: product.publication?.reviewedAt || null, readiness: product.readiness };
  });
  const uniqueAssets = [...new Map(localAssets.map((asset) => [asset.sha256, asset])).values()];
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceCurrency: manifest.source.currency, displayCurrency: manifest.source.displayCurrency, usdDivisor: manifest.source.usdDivisor, styles: products.length, assetCount: media.assets.length, assetBytes: media.assets.reduce((sum, item) => sum + item.bytes, 0), localVerifiedAssetCount: localAssets.length, localAssetIssues: checks.filter((item) => item.issue), uniqueAssetFiles: uniqueAssets.length, uniqueAssetBytes: uniqueAssets.reduce((sum, item) => sum + item.bytes, 0), products };
  await json(path.join(LIBRARY, 'library-report.json'), result);
  return { mode: 'library-report', ...result };
}
function sourcePriceForMapping(source, mapping) {
  const valid = (value) => Number.isFinite(value) && value > 0 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
  if (!mapping.sourceVariantSku) return valid(source.sourcePriceUsd)
    ? { price: source.sourcePriceUsd, skipReason: null }
    : { price: null, skipReason: 'source-style-price-missing' };
  const matches = source.variants.flatMap((variant) => {
    if (!variant.resolved || variant.available !== true || !(variant.availableQty > 0)) return [];
    const bases = (variant.baseVariants || []).filter((base) => base.sourceSku === mapping.sourceVariantSku);
    return bases.length ? bases.filter((base) => base.stockQty > 0).map((base) => base.prices?.resale?.usd) : variant.sourceSku === mapping.sourceVariantSku ? [variant.prices?.resale?.usd] : [];
  });
  if (!matches.length) return { price: null, skipReason: 'source-variant-unavailable-or-unresolved' };
  if (matches.some((value) => !valid(value))) return { price: null, skipReason: 'source-variant-price-missing' };
  const unique = [...new Set(matches)];
  return unique.length === 1 ? { price: unique[0], skipReason: null } : { price: null, skipReason: 'source-variant-price-ambiguous' };
}
async function syncPrices(options) {
  const { spawn } = require('node:child_process');
  const args = [path.join(__dirname, 'shusha-sync-prices.mjs'), options.apply ? '--apply' : '--dry-run'];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  process.exitCode = code === null ? 1 : code;
}
function safeError(error) {
  let text = String(error.message || error);
  for (const name of ['DB_PASSWORD', 'DATABASE_URL', 'APIKEY', 'SUUSHA_PRICE_API_KEY']) if (process.env[name]) text = text.split(process.env[name]).join('[REDACTED]');
  return text;
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { console.log('Usage: node scripts/suusha-source.cjs --capture [--new-arrivals 0..24] [--max-pages 1..3] | --download [--download-source-ids L1379,L1383] [--max-files N] [--max-bytes N] | --library-report | --sync-prices [--dry-run | --apply]\nCapture defaults to explicitly mapped existing styles; additions require --new-arrivals. Capture/download never publish. Price sync only updates source USD prices for explicitly mapped existing SKUs, never stock. Missing/ambiguous unavailable source-variant prices are reported as partial and retained; structural conflicts stop the batch. No cookies, login or customer actions.'); return; }
  if (options.mode === 'sync-prices') { await syncPrices(options); return; }
  await fs.mkdir(LIBRARY, { recursive: true });
  const lockPath = path.join(LIBRARY, '.adapter.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600).catch((error) => { if (error.code === 'EEXIST') throw new Error('Another source adapter run is active; inspect the local lock before retrying'); throw error; });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode: options.mode }));
    const result = options.mode === 'capture' ? await capture(options) : options.mode === 'download' ? await download(options) : options.mode === 'library-report' ? await report() : await syncPrices(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.complete === false) process.exitCode = 2;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
module.exports = { money, prices, imageDimensions, argumentsFor, productReviewFingerprint, preserveReview, sourcePriceForMapping };
if (require.main === module) main().catch((error) => { console.error(`Source adapter failed: ${safeError(error)}`); process.exitCode = 1; });
