// Compile the native core and merchant extensions before running. Synthetic
// catalog fields only; no DOM emulator, HTTP, DB, browser or new dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Exercise the native webpack alias builder with the actual brand extension,
// rather than substituting a hand-written ProductProvider or Image component.
process.env.NODE_ENV = 'production';
process.env.NODE_CONFIG = JSON.stringify({ system: { extensions: [
  { name: 'storefront-brand', resolve: 'extensions/storefront-brand', enabled: true, priority: 120 }
] } });
const require = createRequire(import.meta.url);
const { createBaseConfig } = await import('../packages/evershop/dist/lib/webpack/createBaseConfig.js');
const nativeWebpackConfig = createBaseConfig(true);
const resolveComponent = require('enhanced-resolve').create.sync(nativeWebpackConfig.resolve);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@components/')) {
      return { url: pathToFileURL(resolveComponent(process.cwd(), specifier)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (/\.(?:scss|css)$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  }
});

const { Media } = await import('@components/frontStore/catalog/Media.js');
const { Media: NativeMedia } = await import('../packages/evershop/dist/components/frontStore/catalog/Media.js');
const { ProductProvider } = await import('../packages/evershop/dist/components/frontStore/catalog/ProductContext.js');
const { AppProvider } = await import('../packages/evershop/dist/components/common/context/app.js');
const { scanRouteComponents } = await import('../packages/evershop/dist/lib/componee/scanForComponents.js');
const { AUTOPLAY_INTERVAL_MS, galleryImages, galleryIdentity, galleryPlaybackPolicy, watchGalleryEnvironment } =
  await import('../extensions/storefront-brand/src/services/galleryAutoplay.js');

const product = {
  productId: 9001, uuid: '11111111-2222-4333-8444-555555555555', sku: 'SHUSHA-L9001',
  name: 'Synthetic <Summer> Dress', description: [], inventory: { isInStock: true },
  image: { url: '/assets/synthetic/first.webp', alt: 'First <view>' },
  gallery: [{ url: '/assets/synthetic/second.webp' }, { url: '/assets/synthetic/third.webp', alt: 'Third view' }]
};
function nodesMatching(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => nodesMatching(child, predicate))];
}
function renderGallery(value = product, props = {}, dimensions = { width: 900, height: 1350 }) {
  return renderToStaticMarkup(React.createElement(AppProvider,
    { value: { config: { catalog: { imageDimensions: dimensions } }, widgets: [], propsMap: {}, graphqlResponse: {} } },
    React.createElement(ProductProvider, { product: value }, React.createElement(Media, props))));
}
const playing = {
  imageCount: 3, mounted: true, manualPaused: false, userRequestedPlay: false,
  reducedMotion: false, hovered: false, focused: false, modalOpen: false, pageVisible: true, interacting: false
};

test('native component aliases resolve the PDP Media override without redirecting shared context or recursing', async () => {
  const expected = path.resolve('extensions/storefront-brand/dist/components/frontStore/catalog/Media.js');
  assert.equal(resolveComponent(process.cwd(), '@components/frontStore/catalog/Media.js'), expected);
  assert.equal(resolveComponent(process.cwd(), '@components/frontStore/catalog/ProductContext.js'),
    path.resolve('packages/evershop/dist/components/frontStore/catalog/ProductContext.js'));
  assert.equal(resolveComponent(process.cwd(), '@components/common/Image.js'),
    path.resolve('packages/evershop/dist/components/common/Image.js'));
  assert.notEqual(Media, NativeMedia);
  const source = await readFile('extensions/storefront-brand/src/components/frontStore/catalog/Media.jsx', 'utf8');
  assert.doesNotMatch(source, /from\s+['"]@components\/frontStore\/catalog\/Media(?:\.js)?['"]/);
  assert.throws(() => renderToStaticMarkup(React.createElement(Media)), /useProduct must be used within a ProductProvider/);
});

test('native route discovery keeps ProductView on the product route without adding the gallery to the homepage', () => {
  const modules = [{ name: 'catalog', path: path.resolve('packages/evershop/dist/modules/catalog') },
    { name: 'storefront-brand', path: path.resolve('extensions/storefront-brand/dist') }];
  const detail = scanRouteComponents({ id: 'productView', isAdmin: false }, modules);
  const homepage = scanRouteComponents({ id: 'homepage', isAdmin: false }, modules);
  assert.equal(detail['productView/ProductView.js'], path.resolve('packages/evershop/dist/modules/catalog/pages/frontStore/productView/ProductView.js'));
  assert.equal(homepage['productView/ProductView.js'], undefined);
  assert.equal(Object.values(homepage).includes(path.resolve('extensions/storefront-brand/dist/components/frontStore/catalog/Media.js')), false);
});

test('SSR renders the first real product image with native dimensions and starts no autoplay interval', t => {
  const timer = t.mock.method(globalThis, 'setInterval', () => { throw new Error('SSR must not start autoplay'); });
  const html = renderGallery();
  assert.match(html, /product-media-container/);
  assert.match(html, /first\.webp/);
  assert.match(html, /alt="First &lt;view&gt;"/);
  assert.match(html, /width="900" height="1350"/);
  assert.match(html, /srcSet="\/images\?src=/);
  assert.match(html, /sizes="\(max-width: 1024px\) 100vw, 50vw"/);
  assert.match(html, /shusha-gallery-autoplay/);
  const document = require('htmlparser2').parseDocument(html);
  const firstCurrentSlide = nodesMatching(document, node => node.attribs?.['data-index'] === '0'
    && node.attribs?.class?.split(/\s+/).includes('slick-current'))[0];
  assert.ok(firstCurrentSlide, 'the server-rendered active slide is the first product image');
  assert.match(nodesMatching(firstCurrentSlide, node => node.name === 'img')[0].attribs.src, /first\.webp/);
  assert.equal(timer.mock.callCount(), 0);
  assert.equal(galleryPlaybackPolicy({ ...playing, mounted: false }).autoplay, false);
});

test('Play/Pause and fullscreen controls are explicit buttons outside the focus and hover pausing stage', () => {
  const document = require('htmlparser2').parseDocument(renderGallery());
  const button = nodesMatching(document, node => node.attribs?.class?.split(/\s+/).includes('shusha-gallery-autoplay'))[0];
  assert.equal(button?.name, 'button'); assert.equal(button.attribs.type, 'button');
  assert.match(button.attribs['aria-label'], /^(?:Play|Pause) slideshow$/);
  for (let parent = button.parent; parent; parent = parent.parent) {
    assert.equal(parent.attribs?.class?.split(/\s+/).includes('shusha-gallery-stage') || false, false,
      'keyboard or pointer activation of Play cannot remain blocked by gallery-stage focus/hover');
  }
  const fullscreen = nodesMatching(document, node => node.attribs?.class?.split(/\s+/).includes('shusha-gallery-open-fullscreen'));
  assert.equal(fullscreen.length, 1); assert.equal(fullscreen[0].name, 'button');
  assert.equal(fullscreen[0].attribs.type, 'button'); assert.equal(fullscreen[0].attribs['aria-label'], 'Open fullscreen view');
  assert.equal(fullscreen[0].attribs['aria-haspopup'], 'dialog');
  for (let parent = fullscreen[0].parent; parent; parent = parent.parent) {
    assert.equal(parent.attribs?.class?.split(/\s+/).includes('slick-slide') || false, false,
      'the keyboard fullscreen control is not duplicated in hidden Slick clones');
  }
});

test('hidden original slides and infinite-loop clones have no tabbable descendants', () => {
  const document = require('htmlparser2').parseDocument(renderGallery());
  const slides = nodesMatching(document, node => node.attribs?.class?.split(/\s+/).includes('slick-slide'));
  assert.ok(slides.some(slide => Number(slide.attribs['data-index']) < 0), 'the real Slick preclone is exercised');
  assert.ok(slides.some(slide => Number(slide.attribs['data-index']) >= 3), 'the real Slick postclones are exercised');
  const hidden = slides.filter(slide => slide.attribs['aria-hidden'] === 'true');
  assert.ok(hidden.some(slide => ['1', '2'].includes(slide.attribs['data-index'])), 'inactive originals are exercised');
  for (const slide of hidden) {
    const tabbable = nodesMatching(slide, node => {
      if (!node.attribs || node.attribs.disabled !== undefined) return false;
      if (node.attribs.tabindex !== undefined) return Number(node.attribs.tabindex) >= 0;
      if (['button', 'select', 'textarea', 'iframe', 'object', 'embed'].includes(node.name)) return true;
      if (node.name === 'input') return node.attribs.type !== 'hidden';
      return ['a', 'area'].includes(node.name) && node.attribs.href !== undefined
        || node.attribs.contenteditable === '' || node.attribs.contenteditable === 'true';
    });
    assert.deepEqual(tabbable, [], `hidden slide ${slide.attribs['data-index']} cannot receive Tab focus`);
    assert.equal(nodesMatching(slide, node => node.name === 'img').length, 1, 'hidden slides retain their gallery images');
  }
  const visible = slides.filter(slide => slide.attribs['aria-hidden'] === 'false');
  assert.equal(visible.length, 1); assert.equal(visible[0].attribs['data-index'], '0');
  assert.match(nodesMatching(visible[0], node => node.name === 'img')[0].attribs.src, /first\.webp/);
});

test('native image size props override catalog defaults and retain the supplied aspect ratio', () => {
  const html = renderGallery(product, { imageSize: { width: 400, height: 600 }, thumbnailSize: { width: 66, height: 99 } });
  assert.match(html, /width="400" height="600"/);
  assert.match(html, /width="66" height="99"/);
  assert.match(html, /aspect-ratio:400 \/ 600/);
});

test('single-image and missing-image products have no slideshow autoplay control', () => {
  const single = renderGallery({ ...product, gallery: [] });
  assert.match(single, /first\.webp/);
  assert.doesNotMatch(single, /shusha-gallery-autoplay/);
  assert.match(single, /shusha-gallery-open-fullscreen/);
  const empty = renderGallery({ ...product, image: undefined, gallery: [] });
  assert.doesNotMatch(empty, /<img\b|shusha-gallery-autoplay|shusha-gallery-open-fullscreen/);
  assert.match(empty, /<svg\b/);
  for (const imageCount of [0, 1]) assert.equal(galleryPlaybackPolicy({ ...playing, imageCount }).autoplay, false);
});

test('gallery source order and variant identity stay deterministic while invalid and duplicate images are removed', () => {
  const images = galleryImages({ ...product, gallery: [product.image, null, { url: '' }, { url: '#missing' },
    { url: 'javascript:alert(1)' }, { url: 'https://synthetic:password@example.invalid/image.webp' }, ...product.gallery] });
  assert.deepEqual(images.map(image => image.url), [product.image.url, ...product.gallery.map(image => image.url)]);
  assert.equal(images[0].alt, 'First <view>');
  assert.equal(images[1].alt, product.name);
  assert.equal(galleryIdentity(product, images), galleryIdentity({ ...product }, [...images]));
  assert.notEqual(galleryIdentity(product, images), galleryIdentity({ ...product, uuid: '22222222-3333-4444-8555-666666666666', productId: 9002, sku: 'SHUSHA-L9001-V-SYN-BLUE-M' }, images));
  assert.notEqual(galleryIdentity(product, images), galleryIdentity(product, [...images].reverse()));
});

test('autoplay policy pauses independently for hover, focus, zoom, hidden page and interaction', () => {
  assert.equal(AUTOPLAY_INTERVAL_MS, 5000);
  assert.equal(galleryPlaybackPolicy(playing).autoplay, true);
  for (const reason of ['hovered', 'focused', 'modalOpen', 'interacting']) {
    assert.equal(galleryPlaybackPolicy({ ...playing, [reason]: true }).autoplay, false, reason);
    assert.equal(galleryPlaybackPolicy({ ...playing, [reason]: true, userRequestedPlay: true }).autoplay, false, `${reason} after explicit Play`);
  }
  assert.equal(galleryPlaybackPolicy({ ...playing, pageVisible: false }).autoplay, false);
  assert.equal(galleryPlaybackPolicy({ ...playing, manualPaused: true, userRequestedPlay: true }).autoplay, false);
  assert.equal(galleryPlaybackPolicy({ ...playing, manualPaused: true, imageCount: 2 }).autoplay, false);
});

test('reduced-motion preference disables default autoplay and transitions; explicit Play retains zero animation', () => {
  const reduced = galleryPlaybackPolicy({ ...playing, reducedMotion: true });
  assert.equal(reduced.autoplay, false);
  assert.equal(reduced.transitionSpeed, 0);
  const requested = galleryPlaybackPolicy({ ...playing, reducedMotion: true, userRequestedPlay: true });
  assert.equal(requested.autoplay, true);
  assert.equal(requested.transitionSpeed, 0);
});

function eventTarget(properties = {}) {
  const listeners = new Map();
  return { ...properties, listeners,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, value = {}) { for (const listener of [...listeners.get(type) || []]) listener(value); },
    listenerCount(type) { return listeners.get(type)?.size || 0; }
  };
}
test('real environment watcher immediately reports state and removes modern listeners on cleanup', () => {
  const page = eventTarget({ hidden: false, visibilityState: 'visible' });
  const motion = eventTarget({ matches: false });
  const states = [];
  const cleanup = watchGalleryEnvironment({ page, matchMedia: query => {
    assert.equal(query, '(prefers-reduced-motion: reduce)'); return motion;
  }, onChange: state => states.push(state) });
  assert.deepEqual(states.at(-1), { pageVisible: true, reducedMotion: false });
  assert.equal(page.listenerCount('visibilitychange'), 1); assert.equal(motion.listenerCount('change'), 1);
  page.hidden = true; page.visibilityState = 'hidden'; page.emit('visibilitychange');
  assert.deepEqual(states.at(-1), { pageVisible: false, reducedMotion: false });
  motion.matches = true; motion.emit('change', { matches: true });
  assert.deepEqual(states.at(-1), { pageVisible: false, reducedMotion: true });
  const queuedVisibility = [...page.listeners.get('visibilitychange')][0], queuedMotion = [...motion.listeners.get('change')][0];
  cleanup(); cleanup();
  assert.equal(page.listenerCount('visibilitychange'), 0); assert.equal(motion.listenerCount('change'), 0);
  const calls = states.length; page.emit('visibilitychange'); motion.emit('change');
  queuedVisibility(); queuedMotion(); assert.equal(states.length, calls, 'callbacks queued before unmount cannot update stopped state');
});

test('legacy matchMedia listeners are removed with the same function reference', () => {
  const page = eventTarget({ hidden: false, visibilityState: 'visible' });
  const listeners = new Set(), removed = [];
  const motion = { matches: true, addListener: listener => listeners.add(listener),
    removeListener: listener => { removed.push(listener); listeners.delete(listener); } };
  const states = [];
  const cleanup = watchGalleryEnvironment({ page, matchMedia: () => motion, onChange: state => states.push(state) });
  assert.deepEqual(states.at(-1), { pageVisible: true, reducedMotion: true });
  assert.equal(listeners.size, 1); const registered = [...listeners][0];
  cleanup(); cleanup();
  assert.equal(listeners.size, 0); assert.deepEqual(removed, [registered]);
  assert.equal(page.listenerCount('visibilitychange'), 0);
});

test('actual Slick explicit Play clears sticky focus and both Pause and unmount release owned timers', t => {
  const Slider = require('react-slick').default;
  const { InnerSlider } = require('react-slick/lib/inner-slider.js');
  const defaults = require('react-slick/lib/default-props.js').default;
  const props = { ...defaults, autoplay: true, autoplaySpeed: AUTOPLAY_INTERVAL_MS,
    children: [React.createElement('div', { key: 'first' }), React.createElement('div', { key: 'second' })] };
  const inner = new InnerSlider(props);
  inner.setState = update => { Object.assign(inner.state, typeof update === 'function' ? update(inner.state) : update); };
  const slider = new Slider(props); slider.innerSlider = inner;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const removed = [], cleared = [], originalClear = globalThis.clearInterval;
  t.mock.method(globalThis, 'clearInterval', timer => { cleared.push(timer); originalClear(timer); });
  let disconnected = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener: (...args) => removed.push(args)
  } });
  inner.ro = { disconnect: () => { disconnected = true; } };
  try {
    inner.state.autoplaying = 'focused';
    inner.autoPlay('update'); assert.equal(inner.state.autoplaying, 'focused'); assert.equal(inner.autoplayTimer, undefined);
    slider.slickPlay(); assert.equal(inner.state.autoplaying, 'playing'); assert.ok(inner.autoplayTimer);
    slider.slickPause(); assert.equal(inner.state.autoplaying, 'paused'); assert.equal(inner.autoplayTimer, null);
    slider.slickPlay(); const ownedTimer = inner.autoplayTimer;
    inner.componentWillUnmount();
    assert.ok(cleared.includes(ownedTimer)); assert.equal(disconnected, true);
    assert.deepEqual(removed, [['resize', inner.onWindowResized]]);
  } finally {
    if (inner.autoplayTimer) originalClear(inner.autoplayTimer);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
  }
});
