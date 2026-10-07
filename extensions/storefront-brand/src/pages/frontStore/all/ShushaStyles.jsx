import React from 'react';
import './shusha.scss';

// CMS text blocks deliberately sanitize <style>. Brand styles are a compiled
// native page component so existing private CMS copy can remain untouched.
export default function ShushaStyles() {
  return null;
}

export const layout = { areaId: 'head', sortOrder: 20 };
