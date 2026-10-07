// Run after compiling the brand extension. No fonts, Sharp, DB or HTTP needed.
import assert from 'node:assert/strict';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Logo, { layout, query } from '../../extensions/storefront-brand/dist/pages/frontStore/all/Logo.js';
import { layout as nativeLayout, query as nativeQuery } from '../../packages/evershop/dist/modules/base/pages/frontStore/all/Logo.js';
import { Image } from '@evershop/evershop/components/common/Image';
import { scanRouteComponents } from '../../packages/evershop/dist/lib/componee/scanForComponents.js';

const setting = { storeName: 'SHUSHA', logo: '/assets/shusha/shusha-wordmark.svg', logoWidth: '200', logoHeight: '40' };
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const result = render(Logo, { setting });
assert.match(result, /<img[^>]*src="\/assets\/shusha\/shusha-wordmark\.svg"/);
assert.match(result, /width="200" height="40"/);
assert.match(result, /<a[^>]*href="\/"[^>]*aria-label="SHUSHA – home"/);
assert.doesNotMatch(result, /\/images\?|f=webp/);

const other = { ...setting, storeName: 'Another store', logo: '/assets/merchant-logo.png', logoWidth: '320', logoHeight: '64' };
const otherResult = render(Logo, { setting: other });
const nativeImage = render(Image, { src: other.logo, alt: '', width: 320, height: 64, sizes: '320px', quality: 85, className: 'max-h-10 w-auto max-w-full' });
assert.equal(otherResult.match(/<img\b[^>]*>/)?.[0], nativeImage.match(/<img\b[^>]*>/)?.[0]);
assert.match(otherResult, /aria-label="Another store – home"/);
assert.match(otherResult, /srcSet="\/images\?/);
for (const props of [{ setting: { storeName: 'Another store' } }, {}]) {
  const fallback = render(Logo, props);
  assert.match(fallback, />SHUSHA<\/span>/);
  assert.doesNotMatch(fallback, /<img|<svg/);
}
assert.deepEqual(layout, nativeLayout);
assert.equal(query.replace(/\s+/g, ' ').trim(), nativeQuery.replace(/\s+/g, ' ').trim());
const components = scanRouteComponents({ id: 'homepage', isAdmin: false }, [
  { name: 'base', path: path.resolve('packages/evershop/dist/modules/base') },
  { name: 'storefront-brand', path: path.resolve('extensions/storefront-brand/dist') }
]);
assert.equal(components['all/Logo.js'], path.resolve('extensions/storefront-brand/dist/pages/frontStore/all/Logo.js'));
console.log(JSON.stringify({ status: 'passed', nativeVersion: '2.2.1', rawShushaSvg: true, serverFontDependency: false, publicImageFallback: true, safeMissingLogoFallback: true, nativePageOverrideVerified: true }));
