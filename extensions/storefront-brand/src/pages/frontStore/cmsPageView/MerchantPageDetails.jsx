import React from 'react';
import MerchantContactCard from '../../../components/MerchantContactCard.js';
import { ArrowUpRight } from 'lucide-react';

export default function MerchantPageDetails({ merchantPage, publicMerchantProfile }) {
  if (!['about', 'contact'].includes(merchantPage?.urlKey)) return null;
  const isContact = merchantPage.urlKey === 'contact';
  return (
    <aside className="shusha-company-page" aria-label="SHUSHA customer support">
      <div className="shusha-company-sidebar">
        <MerchantContactCard publicMerchantProfile={publicMerchantProfile} />
        <div className="shusha-company-help">
          <span className="shusha-contact-label">Your order, with personal support</span>
          <p>Availability, shipping and payment details are confirmed personally before you pay.</p>
          <a href={isContact ? '/how-to-order' : '/contact'}>{isContact ? 'How to order' : 'Talk to us'}<ArrowUpRight size={16} aria-hidden="true" focusable="false" /></a>
        </div>
      </div>
    </aside>
  );
}

export const layout = { areaId: 'content', sortOrder: 10 };
export const query = `
  query Query {
    merchantPage: currentCmsPage { urlKey }
    publicMerchantProfile {
      shopName legalName
      address { line1 line2 city postalCode country }
      support { email whatsappSriLanka whatsappChina }
    }
  }
`;
