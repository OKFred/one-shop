import React from 'react';
import { Image } from '@evershop/evershop/components/common/Image';

const WORDMARK = '/assets/shusha/shusha-wordmark.svg';

export default function Logo(props) {
  const setting = props?.setting;
  const logo = setting?.logo;
  const storeName = setting?.storeName || 'SHUSHA';
  const width = Number(setting?.logoWidth) > 0 && Number.isFinite(Number(setting.logoWidth)) ? Number(setting.logoWidth) : 200;
  const height = Number(setting?.logoHeight) > 0 && Number.isFinite(Number(setting.logoHeight)) ? Number(setting.logoHeight) : 40;
  // Let the browser render the preserved SVG text. Rasterizing this wordmark
  // through Sharp requires server fonts that the pinned slim image omits.
  return (
    <div className="logo flex justify-center items-center">
      <a href="/" className="logo-icon" aria-label={`${storeName} – home`}>
        {logo === WORDMARK && <img src={WORDMARK} alt="" width={200} height={40} className="max-h-10 w-auto max-w-full" />}
        {logo && logo !== WORDMARK && <Image src={logo} alt="" width={width} height={height} sizes={`${Math.min(width, 768)}px`} quality={85} className="max-h-10 w-auto max-w-full" />}
        {!logo && <span className="font-semibold text-xl tracking-widest">SHUSHA</span>}
      </a>
    </div>
  );
}

// Native page discovery reads these literal declarations from the source.
export const layout = { areaId: 'headerMiddleCenter', sortOrder: 10 };
export const query = `
  query query {
    setting {
      logo
      logoWidth
      logoHeight
      storeName
    }
  }
`;
