import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { renderer } from './theme/render.mjs';

const source = await readFile(new URL('../shopify/theme/assets/shusha-gallery-autoplay.js', import.meta.url), 'utf8');

// Small platform doubles run the actual asset and its event/timer lifecycle.
// Liquid rendering below separately checks the actual native gallery markup.
class Element {
  constructor() {
    this.listeners = new Map(); this.dataset = {}; this.attributes = new Map(); this.children = [];
    this.textContent = ''; this.hidden = false;
    const classes = new Set();
    this.classList = { contains: value => classes.has(value), toggle: (value, force) => {
      if (force === undefined ? !classes.has(value) : force) classes.add(value); else classes.delete(value);
    } };
  }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, properties = {}) { for (const fn of this.listeners.get(type) || []) fn({ target: this, ...properties }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

function harness({ count = 3, reduced = false, desktop = true, legacyQueries = false, nonImage = false } = {}) {
  let definition;
  const registered = new Map(); const timers = new Map(); const observers = []; let nextTimer = 0;
  const gallery = new Element(), viewer = new Element(), thumbnails = new Element(), list = new Element();
  const modal = new Element(), button = new Element(), document = new Element();
  const makeItem = (index, image = true) => {
    const item = new Element(); item.dataset.mediaId = `synthetic-${index}`; item.offsetLeft = index * 100;
    item.querySelector = () => image ? new Element() : null;
    item.classList.toggle('is-active', index === 0); return item;
  };
  list.children = Array.from({ length: count }, (_, index) => makeItem(index));
  if (nonImage) list.children.push(makeItem(count, false));
  list.scrollLeft = 0; list.scrolls = [];
  list.scrollTo = options => { list.scrolls.push(options); list.scrollLeft = options.left; };
  list.querySelectorAll = () => list.children;
  viewer.querySelector = () => list; viewer.children = [list]; gallery.children = [viewer, thumbnails];
  gallery.id = 'MediaGallery-synthetic'; gallery.thumbnailCalls = [];
  gallery.setActiveThumbnail = item => gallery.thumbnailCalls.push(item);
  gallery.querySelector = selector => selector.startsWith('[id^="GalleryViewer') ? viewer :
    selector.startsWith('[id^="GalleryThumbnails') ? thumbnails : selector.startsWith('[data-target') ? new Element() : null;
  document.hidden = false; document.activeElement = null; document.getElementById = () => modal;
  const queries = new Map();
  for (const [query, matches] of [['(min-width: 750px)', desktop], ['(prefers-reduced-motion: reduce)', reduced]]) {
    const value = new Element(); value.matches = matches;
    if (legacyQueries) {
      value.addListener = fn => Element.prototype.addEventListener.call(value, 'change', fn);
      value.removeListener = fn => Element.prototype.removeEventListener.call(value, 'change', fn);
      value.addEventListener = undefined;
    }
    queries.set(query, value);
  }
  const window = {
    matchMedia: query => queries.get(query),
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    // A call here would be a real regression: automatic steps must never move the page.
    scrollTo: () => { throw new Error('automatic document scroll'); }
  };
  class Observer {
    constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  vm.runInNewContext(source, {
    customElements: { get: name => registered.get(name), define: (name, value) => { registered.set(name, value); definition = value; } },
    HTMLElement: Element, window, document, MutationObserver: Observer, IntersectionObserver: Observer, queueMicrotask
  });
  const control = new definition(); control.children = [button]; gallery.children.push(control);
  control.closest = () => gallery; control.querySelector = () => button;
  control.connectedCallback();
  const fireTimer = () => {
    assert.equal(timers.size, 1); const [id, timer] = timers.entries().next().value;
    assert.equal(timer.delay, 5000); timers.delete(id); timer.fn();
  };
  const mutate = () => observers.find(observer => observer.target === list).fn([]);
  const modalChanged = () => observers.find(observer => observer.target === modal).fn([]);
  return { control, gallery, viewer, thumbnails, list, modal, button, document, timers, observers, queries,
    makeItem, fireTimer, mutate, modalChanged, window };
}

test('five-second image rotation wraps and only scrolls the native image list', () => {
  const h = harness(); assert.equal(h.control.hidden, false); assert.equal(h.button.textContent, 'Pause slideshow');
  h.fireTimer(); assert.equal(h.list.children[1].classList.contains('is-active'), true);
  h.fireTimer(); h.fireTimer(); assert.equal(h.list.children[0].classList.contains('is-active'), true);
  assert.equal(h.gallery.thumbnailCalls.length, 3); assert.equal(h.timers.size, 1);
});

test('explicit pause is durable; explicit play works while its own button keeps focus', () => {
  const h = harness(); h.button.emit('click'); assert.equal(h.timers.size, 0);
  h.document.emit('visibilitychange'); h.mutate(); assert.equal(h.timers.size, 0);
  h.document.activeElement = h.button; h.button.emit('click'); assert.equal(h.timers.size, 1);
  assert.equal(h.button.attributes.get('aria-pressed'), 'true'); h.fireTimer();
});

test('hover, keyboard focus and touch pause, then resume after interaction', async () => {
  const h = harness(); h.viewer.emit('pointerenter', { pointerType: 'mouse' }); assert.equal(h.timers.size, 0);
  h.viewer.emit('pointerleave', { pointerType: 'mouse' }); assert.equal(h.timers.size, 1);
  h.document.activeElement = h.list.children[0]; h.viewer.emit('focusin'); assert.equal(h.timers.size, 0);
  h.viewer.emit('focusout'); h.document.activeElement = h.button;
  await Promise.resolve(); assert.equal(h.timers.size, 1);
  h.viewer.emit('pointerdown', { pointerType: 'touch' }); assert.equal(h.timers.size, 0);
  h.document.emit('pointerup'); assert.equal(h.timers.size, 1);
});

test('touch pointer entry and compatibility mouse events cannot leave hover stuck after a tap', () => {
  const h = harness();
  h.viewer.emit('pointerenter', { pointerType: 'touch' }); assert.equal(h.timers.size, 1);
  h.viewer.emit('pointerdown', { pointerType: 'touch' }); assert.equal(h.timers.size, 0);
  h.viewer.emit('mouseenter'); // Android/iOS compatibility event without a mouseleave.
  h.document.emit('pointerup', { pointerType: 'touch' }); assert.equal(h.timers.size, 1);
  h.viewer.emit('pointerdown', { pointerType: 'touch' }); h.document.emit('pointercancel'); assert.equal(h.timers.size, 1);
  h.viewer.emit('pointerenter', { pointerType: 'pen' }); assert.equal(h.timers.size, 0);
  h.viewer.emit('pointerleave', { pointerType: 'pen' }); assert.equal(h.timers.size, 1);
});

test('hidden, native modal and offscreen galleries suspend the timer', () => {
  const h = harness(); h.document.hidden = true; h.document.emit('visibilitychange'); assert.equal(h.timers.size, 0);
  h.document.hidden = false; h.document.emit('visibilitychange'); assert.equal(h.timers.size, 1);
  h.modal.setAttribute('open', ''); h.modalChanged(); assert.equal(h.timers.size, 0);
  h.modal.removeAttribute('open'); h.modalChanged(); assert.equal(h.timers.size, 1);
  const observer = h.observers.find(value => value.target === h.viewer);
  observer.fn([{ isIntersecting: false }]); assert.equal(h.timers.size, 0);
  observer.fn([{ isIntersecting: true }]); assert.equal(h.timers.size, 1);
});

test('reduced motion starts paused and an explicit play uses an instant transition', () => {
  const h = harness({ reduced: true }); assert.equal(h.timers.size, 0); assert.equal(h.button.textContent.trim(), 'Play slideshow');
  h.button.emit('click'); h.fireTimer(); assert.equal(h.list.scrolls[0].behavior, 'instant');
});

test('motion changes pause a prior explicit Play while an explicit Pause survives all preference changes', () => {
  const h = harness(); const query = h.queries.get('(prefers-reduced-motion: reduce)');
  query.matches = true; query.emit('change'); assert.equal(h.timers.size, 0);
  h.button.emit('click'); assert.equal(h.timers.size, 1);
  query.matches = false; query.emit('change'); assert.equal(h.timers.size, 1);
  query.matches = true; query.emit('change'); assert.equal(h.timers.size, 0);
  query.matches = false; query.emit('change'); assert.equal(h.timers.size, 1);
  h.button.emit('click'); assert.equal(h.timers.size, 0);
  query.matches = true; query.emit('change'); query.matches = false; query.emit('change');
  assert.equal(h.timers.size, 0);
});

test('single image hides the control, and variant reconciliation re-reads current nodes', () => {
  const single = harness({ count: 1 }); assert.equal(single.control.hidden, true); assert.equal(single.timers.size, 0);
  single.list.children.push(single.makeItem(1)); single.mutate(); assert.equal(single.timers.size, 1);
  const replacement = single.makeItem(8); single.list.children[1] = replacement; single.mutate(); single.fireTimer();
  assert.equal(replacement.classList.contains('is-active'), true);
  single.list.children = [replacement]; single.mutate(); assert.equal(single.control.hidden, true); assert.equal(single.timers.size, 0);
});

test('mobile rotation follows the current scroll position and never auto-plays video', () => {
  const h = harness({ desktop: false, nonImage: true }); h.list.scrollLeft = 100; h.viewer.emit('slideChanged');
  h.fireTimer(); assert.equal(h.list.scrollLeft, 200);
  h.list.scrollLeft = 300; h.viewer.emit('slideChanged'); assert.equal(h.timers.size, 0);
  h.list.scrollLeft = 0; h.viewer.emit('slideChanged'); assert.equal(h.timers.size, 1);
});

for (const legacyQueries of [false, true]) test(`disconnect removes timers, observers and ${legacyQueries ? 'legacy' : 'modern'} media listeners`, () => {
  const h = harness({ legacyQueries }); h.control.disconnectedCallback(); assert.equal(h.timers.size, 0);
  for (const target of [h.viewer, h.thumbnails, h.gallery, h.button, h.document, ...h.queries.values()]) assert.equal(target.listenerCount(), 0);
  assert(h.observers.every(observer => observer.disconnected));
  h.observers.forEach(observer => observer.fn([])); assert.equal(h.timers.size, 0);
  h.control.connectedCallback(); assert.equal(h.timers.size, 1);
});

async function renderGallery({ page = 'product', enabled = true, count = 2 } = {}) {
  const media = Array.from({ length: count }, (_, index) => ({ id: index + 1, media_type: 'image', src: `/synthetic-${index}.jpg`,
    preview_image: { src: `/synthetic-${index}.jpg`, aspect_ratio: 1 }, aspect_ratio: 1 }));
  const section = { id: 'synthetic', settings: { shusha_gallery_autoplay: enabled, gallery_layout: 'thumbnail_slider',
    mobile_thumbnails: 'show', media_size: 'large', hide_variants: false, image_zoom: 'lightbox', media_fit: 'contain' } };
  const r = await renderer({ request: { page_type: page }, section,
    product: { media, selected_or_first_available_variant: { featured_media: media[0] } } });
  return r.snippet('product-media-gallery', { variant_images: [] });
}

test('actual Liquid keeps native images, thumbnails and zoom with a progressive PDP-only control', async () => {
  const html = await renderGallery();
  assert.match(html, /data-shusha-gallery-autoplay/); assert.match(html, /shusha-gallery-autoplay\.js/);
  assert.match(html, /<shusha-gallery-autoplay hidden>/); assert.match(html, /aria-controls="Slider-Gallery-synthetic"/);
  assert.match(html, /is-active/); assert.match(html, /GalleryThumbnails-synthetic/);
  assert.match(html, /product__media-zoom-lightbox/); assert.match(html, /data-modal="#ProductModal-synthetic"/);
  for (const options of [{ page: 'index' }, { enabled: false }]) {
    assert.doesNotMatch(await renderGallery(options), /shusha-gallery-autoplay/);
  }
});

test('merchant template opts into the native thumbnail gallery without changing homepage or slideshow', async () => {
  const product = JSON.parse(await readFile(new URL('../shopify/theme/templates/product.json', import.meta.url), 'utf8'));
  assert.equal(product.sections.main.settings.shusha_gallery_autoplay, true);
  assert.equal(product.sections.main.settings.gallery_layout, 'thumbnail_slider');
  assert.equal(product.sections.main.settings.mobile_thumbnails, 'show');
  assert.doesNotMatch(source, /setActiveMedia\(|fetch\(|XMLHttpRequest|window\.scrollTo\(/);
});
