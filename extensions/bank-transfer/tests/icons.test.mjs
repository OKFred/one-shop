import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BrandIcon from '../dist/components/BrandIcon.js';

test('Offline Wise and WhatsApp render SVG synchronously without fetching icons', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Brand icons must not fetch remotely'); };
  try {
    for (const brand of ['wise', 'whatsapp']) {
      const html = renderToStaticMarkup(React.createElement(BrandIcon, { brand }));
      assert.match(html, /<svg/);
      assert.match(html, /aria-hidden="true"/);
      assert.match(html, /width="20"/);
      assert.match(html, /<path/);
    }
  } finally { globalThis.fetch = originalFetch; }
});
