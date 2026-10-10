import React from 'react';
import { Mail, MapPin, ArrowUpRight } from 'lucide-react';
import BrandIcon from './BrandIcon.js';

const clean = value => typeof value === 'string' ? value.trim() : '';
const whatsapp = value => /^https:\/\/wa\.me\/[1-9]\d{6,14}$/.test(clean(value)) ? clean(value) : '';
const email = value => {
  const address = clean(value);
  return address.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(address) ? address : '';
};

export function merchantAddressLines(profile) {
  const address = profile?.address || {};
  if (!clean(address.line1)) return [];
  return [clean(address.line1), clean(address.line2),
    [clean(address.city), clean(address.postalCode)].filter(Boolean).join(' '), clean(address.country)].filter(Boolean);
}

export default function MerchantContactCard({ publicMerchantProfile, compact = false }) {
  const profile = publicMerchantProfile || {};
  const support = profile.support || {};
  const lines = merchantAddressLines(profile);
  const supportEmail = email(support.email);
  const contacts = [
    { href: whatsapp(support.whatsappSriLanka), label: 'WhatsApp · Sri Lanka' },
    { href: whatsapp(support.whatsappChina), label: 'WhatsApp · China' }
  ].filter(contact => contact.href);
  if (!lines.length && !supportEmail && !contacts.length && !clean(profile.legalName)) return null;

  return (
    <section className={`shusha-contact-card${compact ? ' shusha-contact-card--compact' : ''}`} aria-label="Merchant contact details">
      <h2 className="shusha-contact-card-heading">{compact ? 'Get in touch' : 'Contact details'}</h2>
      {clean(profile.legalName) && <p className="shusha-contact-company">{clean(profile.legalName)}</p>}
      {lines.length > 0 && (
        <div className="shusha-contact-address">
          <MapPin size={18} aria-hidden="true" focusable="false" />
          <div>
            <span className="shusha-contact-label">Contact address</span>
            <address>{lines.map((line, index) => <span key={index}>{line}</span>)}</address>
            {!compact && <a className="shusha-map-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lines.join(', '))}`} target="_blank" rel="noopener noreferrer">View on map <ArrowUpRight size={14} aria-hidden="true" focusable="false" /></a>}
          </div>
        </div>
      )}
      {(contacts.length > 0 || supportEmail) && <div className="shusha-contact-links">
        {contacts.map(contact => <a key={contact.label} href={contact.href} target="_blank" rel="noopener noreferrer"><BrandIcon brand="whatsapp" size={20} /><span>{contact.label}</span><ArrowUpRight className="shusha-contact-arrow" size={15} aria-hidden="true" focusable="false" /></a>)}
        {supportEmail && <a href={`mailto:${encodeURIComponent(supportEmail)}`}><Mail size={18} aria-hidden="true" focusable="false" /><span>{supportEmail}</span></a>}
      </div>}
    </section>
  );
}
