import { Liquid } from './node_modules/liquidjs/dist/liquid.node.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const themeRoot = fileURLToPath(new URL('../../shopify/theme/', import.meta.url));

// Shopify-only transport tags are irrelevant to local HTML acceptance. Keep all
// actual resource, visibility, loop, render and price logic in the native files.
export function localLiquid(source) {
  return source
    .replace(/{%-?\s*(schema|javascript|doc)\s*-?%}[\s\S]*?{%-?\s*end\1\s*-?%}/g, '')
    .replace(/{%-?\s*style\s*-?%}/g, '<style>').replace(/{%-?\s*endstyle\s*-?%}/g, '</style>')
    .replace(/{%-?\s*form\s+[^%]+%}/g, '<form data-local-shopify-form>')
    .replace(/{%-?\s*endform\s*-?%}/g, '</form>')
    .replace(/{%-?\s*paginate\s+[^%]+%}/g, '').replace(/{%-?\s*endpaginate\s*-?%}/g, '');
}

export async function defaults(section) {
  const source = await readFile(path.join(themeRoot, 'sections', `${section}.liquid`), 'utf8');
  const schema = JSON.parse(source.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
  return Object.fromEntries((schema.settings || []).filter(setting => setting.default !== undefined).map(setting => [setting.id, setting.default]));
}

export async function renderer(overrides = {}) {
  const settings = JSON.parse(await readFile(path.join(themeRoot, 'config/settings_data.json'), 'utf8')).current;
  const translations = JSON.parse(await readFile(path.join(themeRoot, 'locales/en.default.json'), 'utf8'));
  const globals = {
    settings, pages: {}, collections: {}, shop: { name: 'SHUSHA', customer_accounts_enabled: false },
    routes: { root_url: '/', all_products_collection_url: '/collections/all', search_url: '/search', cart_url: '/cart', account_url: '/account' },
    request: { page_type: 'index', origin: 'https://synthetic-shop.example' },
    cart: { item_count: 0 }, localization: { available_languages: [], available_countries: [] }, ...overrides
  };
  const engine = new Liquid({ root: [path.join(themeRoot, 'snippets')], extname: '.liquid', globals });
  const nativeFileSystem = engine.options.fs;
  engine.options.fs = { ...nativeFileSystem, readFile: async filename => localLiquid(await nativeFileSystem.readFile(filename)) };
  engine.registerFilter('asset_url', name => `/assets/${name}`);
  engine.registerFilter('stylesheet_tag', url => `<link rel="stylesheet" href="${url}">`);
  engine.registerFilter('inline_asset_content', name => readFile(path.join(themeRoot, 'assets', name), 'utf8'));
  engine.registerFilter('image_url', image => image?.src || image?.url || String(image));
  engine.registerFilter('image_tag', url => `<img src="${url}" alt="Synthetic reviewed image">`);
  engine.registerFilter('placeholder_svg_tag', name => `<svg data-onboarding-placeholder="${name}"></svg>`);
  engine.registerFilter('money', value => `$${(Number(value) / 100).toFixed(2)}`);
  engine.registerFilter('money_with_currency', value => `$${(Number(value) / 100).toFixed(2)} USD`);
  engine.registerFilter('t', (key, args = {}) => {
    let result = key.split('.').reduce((node, segment) => node?.[segment], translations) || key;
    if (typeof result !== 'string') result = key;
    for (const [name, value] of Object.entries(args)) result = result.replaceAll(`{{ ${name} }}`, String(value));
    return result;
  });
  return {
    engine, globals,
    async section(name, options = {}) {
      const source = localLiquid(await readFile(path.join(themeRoot, 'sections', `${name}.liquid`), 'utf8'));
      const section = { id: name, blocks: [], ...options, settings: { ...await defaults(name), ...options.settings } };
      // Shopify exposes section globally inside render snippets. LiquidJS scope
      // isolation otherwise hides it and would give misleading header previews.
      const previous = engine.options.globals.section;
      engine.options.globals.section = section;
      try { return await engine.parseAndRender(source, { section }); }
      finally { engine.options.globals.section = previous; }
    },
    snippet(name, args = {}) { return engine.renderFile(name, args); }
  };
}

export function resource(type, handle, properties = {}) {
  return { id: `${type}-${handle}`, handle, title: handle, url: `/${type}/${handle}`, ...properties };
}

export function menuLink(object, properties = {}) {
  return { title: object?.title || 'Missing resource', handle: object?.handle || 'missing', url: object?.url || '/pages/missing', type: 'page_link', object, links: [], ...properties };
}
