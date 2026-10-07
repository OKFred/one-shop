import React from 'react';
import { Icon } from '@iconify/react/offline';
import icons from './brand-icons.js';

export default function BrandIcon({ brand, size = 20 }) {
  const data = icons.icons[brand];
  if (!data) return null;
  return <Icon icon={{ width: icons.width || 24, height: icons.height || 24, ...data }} width={size} height={size} aria-hidden="true" focusable="false" style={{ flexShrink: 0, color: brand === 'whatsapp' ? '#25D366' : 'currentColor' }} />;
}
