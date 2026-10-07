import React from 'react';
import Area from '@evershop/evershop/components/common/Area';
import BrandIcon from '../BrandIcon.js';

export function Footer({ copyRight }) {
  return (
    <footer className="footer mt-20 border-t border-border bg-muted/30 pt-12 pb-8">
      <Area id="footerTop" className="footer__top" isGlobal editableInPageBuilder />
      <div className="page-width grid gap-8 md:grid-cols-3">
        <div><strong>SHUSHA</strong><p className="mt-3 text-sm">Clothing from Sri Lanka, with personal support for worldwide order requests.</p></div>
        <nav aria-label="Customer information" className="grid gap-2 text-sm">
          <a href="/contact">Contact us</a><a href="/shipping-payment">Shipping &amp; payment</a><a href="/how-to-order">How to order</a>
        </nav>
        <div className="grid gap-3 text-sm">
          <a href="https://wa.me/94776369425" className="inline-flex items-center gap-2" target="_blank" rel="noopener noreferrer"><BrandIcon brand="whatsapp" size={18} />WhatsApp · Sri Lanka</a>
          <a href="https://wa.me/8615757106234" className="inline-flex items-center gap-2" target="_blank" rel="noopener noreferrer"><BrandIcon brand="whatsapp" size={18} />WhatsApp · China</a>
          <span className="inline-flex items-center gap-2"><BrandIcon brand="wise" size={18} />Wise / bank transfer after confirmation</span>
        </div>
      </div>
      <div className="footer__middle page-width flex flex-wrap gap-6 mt-6">
        <Area id="footerMiddleLeft" isGlobal editableInPageBuilder />
        <Area id="footerMiddleCenter" isGlobal editableInPageBuilder />
        <Area id="footerMiddleRight" isGlobal editableInPageBuilder />
      </div>
      <div className="page-width mt-8 border-t border-border pt-5 text-sm">{copyRight || '© 2026 SHUSHA'}</div>
    </footer>
  );
}
