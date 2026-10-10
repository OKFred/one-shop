import test from 'node:test';
import assert from 'node:assert/strict';
import { renderer, resource, menuLink } from './theme/render.mjs';

const contact = resource('pages', 'contact', { title: 'Contact SHUSHA' });
const about = resource('pages', 'about', { title: 'About SHUSHA' });
const external = menuLink(null, { type: 'http_link', url: 'https://synthetic-help.example/', title: 'External support', handle: 'external' });
const missingPage = menuLink(null, { title: 'Uncreated ordering page', url: '/pages/how-to-order' });
const missingCollection = menuLink(null, { type: 'collection_link', title: 'Uncreated dresses', url: '/collections/dresses' });
const published = () => {
  const product = resource('products', 'synthetic-style', { title: 'Synthetic published style', price: 3799, price_min: 3799, price_max: 3799,
    available: true, price_varies: false, compare_at_price_varies: false, selected_or_first_available_variant: { price: 3799 },
    featured_media: { preview_image: { src: '/synthetic-style.jpg', aspect_ratio: 1 }, aspect_ratio: 1 },
    featured_image: { src: '/synthetic-style.jpg' }, media: [], options_with_values: [], variants: [] });
  const collection = resource('collections', 'dresses', { title: 'Dresses', products: [product], products_count: 1, all_products_count: 1 });
  return { product, collection };
};

test('empty homepage advertises only the main store and available contact page', async () => {
  const r = await renderer({ pages: { contact } });
  const hero = await r.section('shusha-hero', { settings: { primary_link: 'shopify://collections/all', secondary_link: 'shopify://pages/how-to-order' } });
  assert.match(hero, /<h1[^>]*>SHUSHA<\/h1>/);
  assert.match(hero, /href="https:\/\/shop\.this-time\.com\/"/);
  assert.match(hero, /href="\/pages\/contact"/);
  assert.doesNotMatch(hero, /<figure|<img|onboarding|placeholder|href="[^\"]*(?:how-to-order|collections)|synchroniz/i);
  assert.equal((await r.section('shusha-categories', { blocks: [{ settings: { collection: null } }] })).trim(), '');
  assert.equal((await r.section('featured-collection', { settings: { collection: null } })).trim(), '');
});

test('metadata alone or an empty collection cannot expose native fake products or 19.99', async () => {
  const r = await renderer();
  for (const count of [0, 1]) {
    const empty = resource('collections', 'new-arrivals', { products: [], products_count: 0, all_products_count: count });
    const html = await r.section('featured-collection', { settings: { collection: empty } });
    assert.equal(html.trim(), '');
    assert.doesNotMatch(html, /19\.99|onboarding|placeholder|product-grid/);
  }
});

test('real published collections and products restore native cards with their actual price', async () => {
  const { collection } = published();
  const r = await renderer({ collections: { all: collection, dresses: collection }, pages: { contact } });
  const hero = await r.section('shusha-hero', { settings: { heading: 'Wear your everyday', primary_link: 'shopify://collections/dresses', secondary_link: 'shopify://pages/contact', image: { src: '/reviewed-hero.jpg' } } });
  assert.match(hero, /Wear your everyday/); assert.match(hero, /href="\/collections\/dresses"/); assert.match(hero, /<img src="\/reviewed-hero.jpg"/);
  assert.doesNotMatch(hero, /shopify:\/\/|onboarding|placeholder/);
  const categories = await r.section('shusha-categories', { blocks: [{ settings: { collection } }] });
  assert.match(categories, /href="\/collections\/dresses"/); assert.match(categories, /synthetic-style.jpg/);
  const cards = await r.section('featured-collection', { settings: { collection, quick_add: 'none', products_to_show: 6 } });
  assert.match(cards, /Synthetic published style/); assert.match(cards, /\$37\.99/); assert.match(cards, /href="\/products\/synthetic-style"/);
  assert.doesNotMatch(cards, /19\.99|data-onboarding-placeholder|Example product title/);
});

test('real image-free collection renders its title without inventing a photo', async () => {
  const collection = resource('collections', 'tops', { title: 'Tops', products: [{ title: 'Real product without photo' }], all_products_count: 1 });
  const r = await renderer(); const html = await r.section('shusha-categories', { blocks: [{ settings: { collection } }] });
  assert.match(html, /href="\/collections\/tops"/); assert.match(html, />Tops</);
  assert.doesNotMatch(html, /<img|<svg|placeholder/);
});

test('page and collection URL settings resolve only existing resources', async () => {
  const { collection } = published(); const r = await renderer({ pages: { contact }, collections: { dresses: collection } });
  for (const url of ['shopify://pages/contact', '/pages/contact']) assert.equal((await r.snippet('shusha-link-url', { url })).trim(), '/pages/contact');
  for (const url of ['shopify://collections/dresses', '/collections/dresses']) assert.equal((await r.snippet('shusha-link-url', { url })).trim(), '/collections/dresses');
  for (const url of ['shopify://pages/how-to-order', '/pages/how-to-order', 'shopify://collections/tops', '/collections/tops', 'javascript:alert(1)', '//synthetic.example']) assert.equal((await r.snippet('shusha-link-url', { url })).trim(), '');
  assert.equal((await r.snippet('shusha-link-url', { link: external })).trim(), external.url);
});

test('localized resources and native collection product links retain their actual destinations', async () => {
  const { product, collection } = published();
  const r = await renderer({ pages: { contact }, collections: { dresses: collection } });
  for (const url of ['/en/pages/contact', '/en/collections/dresses', '/collections/dresses/summer', '/pages/contact?return_to=/pages/missing', '/collections/dresses?next=/collections/missing#top', '/search?q=/pages/missing', 'https://synthetic-help.example/pages/missing']) {
    assert.equal((await r.snippet('shusha-link-url', { url })).trim(), url);
  }
  for (const url of ['/en/pages/how-to-order', '/en/collections/missing']) {
    assert.equal((await r.snippet('shusha-link-url', { url })).trim(), '');
  }
  const contextualProduct = menuLink(product, { type: 'product_link', url: '/collections/dresses/products/synthetic-style' });
  assert.equal((await r.snippet('shusha-link-url', { link: contextualProduct })).trim(), contextualProduct.url);
  // A native valid product Drop is authoritative, even if its old collection is
  // absent from global collections. Do not mistake its product handle for one.
  contextualProduct.url = '/collections/old-collection/products/synthetic-style';
  assert.equal((await r.snippet('shusha-link-url', { link: contextualProduct })).trim(), contextualProduct.url);
});

for (const name of ['header-dropdown-menu', 'header-mega-menu', 'header-drawer']) {
  test(`${name} filters deleted PAGE/COLLECTION entries at all three levels`, async () => {
    const nested = menuLink(about, { links: [missingCollection, menuLink(contact, { links: [missingPage, external] })] });
    const r = await renderer({ pages: { contact, about } });
    const html = await r.snippet(name, { section: { settings: { menu: { links: [missingPage, missingCollection, menuLink(contact), external, nested] } } } });
    assert.doesNotMatch(html, /Uncreated|how-to-order|\/collections\/dresses/);
    assert.match(html, /Contact SHUSHA/); assert.match(html, /https:\/\/synthetic-help\.example\//); assert.match(html, /External support/);
  });
  test(`${name} preserves a valid parent as a direct link when all children disappear`, async () => {
    const r = await renderer({ pages: { contact } });
    const html = await r.snippet(name, { section: { settings: { menu: { links: [menuLink(contact, { links: [missingPage, missingCollection] })] } } } });
    assert.match(html, /href="\/pages\/contact"/);
    assert.doesNotMatch(html, /Uncreated|HeaderSubMenu|Details-HeaderMenu-|Details-menu-drawer-menu-item-/);
  });
}

test('a configured but wholly invalid menu renders no hamburger or inline menu', async () => {
  const r = await renderer(); const html = await r.section('header', { settings: { menu: { links: [missingPage, missingCollection] }, cart_type: 'page' } });
  assert.doesNotMatch(html, /<header-drawer|<nav class="header__inline-menu"|header--has-menu|Uncreated/);
  assert.match(html, /SHUSHA/);
});

test('native header integrates both desktop and mobile guards with real published resources', async () => {
  const { collection } = published();
  const r = await renderer({ pages: { contact }, collections: { dresses: collection } });
  const links = [missingPage, menuLink(contact), menuLink(collection, { type: 'collection_link' }), external];
  const html = await r.section('header', { settings: { menu: { links }, menu_type_desktop: 'dropdown' } });
  assert.match(html, /<header-drawer/); assert.match(html, /<nav class="header__inline-menu"/);
  assert.equal((html.match(/href="\/pages\/contact"/g) || []).length, 2);
  assert.equal((html.match(/href="\/collections\/dresses"/g) || []).length, 2);
  assert.equal((html.match(/href="https:\/\/synthetic-help\.example\/"/g) || []).length, 2);
  assert.doesNotMatch(html, /Uncreated|how-to-order/);
});

test('footer removes stale configured resources and preserves public pages without duplicates', async () => {
  const r = await renderer({ pages: { about, contact } });
  const html = await r.section('shusha-footer', { settings: { menu: { links: [missingPage, missingCollection, menuLink(about), external] } } });
  assert.doesNotMatch(html, /Uncreated|how-to-order|\/collections\/dresses/);
  assert.equal((html.match(/href="\/pages\/about"/g) || []).length, 1);
  assert.equal((html.match(/href="\/pages\/contact"/g) || []).length, 1);
  assert.match(html, /https:\/\/synthetic-help\.example\//);
});

test('company pages route customers to the main store until a real catalog exists', async () => {
  const r = await renderer({ pages: { contact } });
  const empty = await r.section('shusha-company-page'); assert.match(empty, /href="https:\/\/shop\.this-time\.com\/"/); assert.doesNotMatch(empty, /href="\/collections\/all"/);
  const { collection } = published(); const active = await renderer({ collections: { all: collection } });
  const html = await active.section('shusha-company-page'); assert.match(html, /href="\/collections\/all"/);
});
