import React from 'react';
import MerchantContactCard from '../../../components/MerchantContactCard.js';
import BrandIcon from '../../../components/BrandIcon.js';

export default function MerchantFooter({ publicMerchantProfile }) {
  return (
    <div className="page-width shusha-footer-details">
      <div className="shusha-footer-brand">
        <a className="shusha-footer-wordmark" href="/" aria-label="SHUSHA home">{publicMerchantProfile?.shopName || 'SHUSHA'}</a>
        <p>Clothing from Sri Lanka.<br />Personal support for worldwide order requests.</p>
        <p className="shusha-footer-payment"><BrandIcon brand="wise" size={20} /><span>Wise / bank transfer<br />after order confirmation</span></p>
      </div>
      <nav className="shusha-footer-nav" aria-label="Shop collections">
        <h2>Explore</h2>
        <a href="/dresses">Dresses</a><a href="/tops">Tops</a><a href="/pants">Pants</a>
      </nav>
      <nav className="shusha-footer-nav" aria-label="Customer information">
        <h2>About your order</h2>
        <a href="/about">About SHUSHA</a><a href="/contact">Contact us</a>
        <a href="/how-to-order">How to order</a><a href="/shipping-payment">Shipping &amp; payment</a>
      </nav>
      <MerchantContactCard publicMerchantProfile={publicMerchantProfile} compact />
    </div>
  );
}

export const layout = { areaId: 'shushaFooterDetails', sortOrder: 10 };
export const query = `
  query Query {
    publicMerchantProfile {
      shopName legalName
      address { line1 line2 city postalCode country }
      support { email whatsappSriLanka whatsappChina }
    }
  }
`;
