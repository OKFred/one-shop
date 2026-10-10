import React from 'react';
import Area from '@evershop/evershop/components/common/Area';

export function Footer({ copyRight }) {
  return (
    <footer className="footer shusha-footer">
      <Area id="footerTop" className="footer__top" isGlobal editableInPageBuilder />
      <Area id="shushaFooterDetails" noOuter />
      <div className="footer__middle page-width flex flex-wrap gap-6 mt-6">
        <Area id="footerMiddleLeft" isGlobal editableInPageBuilder />
        <Area id="footerMiddleCenter" isGlobal editableInPageBuilder />
        <Area id="footerMiddleRight" isGlobal editableInPageBuilder />
      </div>
      <div className="page-width shusha-footer-copyright">{copyRight || '© 2026 SHUSHA'}</div>
    </footer>
  );
}
