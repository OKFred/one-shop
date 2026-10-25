import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Layers, MessageCircle } from 'lucide-react';
import BrandIcon from '../../../components/BrandIcon.js';
import MerchantContactCard from '../../../components/MerchantContactCard.js';
import { buildWholesaleDraft, wholesaleCampaign, wholesaleContactUrl, WHOLESALE_CHANNELS } from '../../../services/wholesaleInquiry.js';
import './Wholesale.scss';

const fields = ['country', 'salesChannel', 'items', 'shopUrl'];
const initialValue = { country: '', salesChannel: '', shopUrl: '', items: '' };

export default function Wholesale({ countries = [], publicMerchantProfile }) {
  const [value, setValue] = useState(initialValue);
  const [errors, setErrors] = useState({});
  const [draft, setDraft] = useState(null);
  const [campaign, setCampaign] = useState({});
  const [clientReady, setClientReady] = useState(false);
  const form = useRef(null);
  const contactUrl = wholesaleContactUrl(publicMerchantProfile?.support?.whatsappSriLanka);
  const available = Boolean(contactUrl && countries.length);

  useEffect(() => {
    setCampaign(wholesaleCampaign(window.location.search));
    setClientReady(true);
  }, []);
  useEffect(() => {
    const first = fields.find(name => errors[name]);
    if (first) form.current?.elements.namedItem(first)?.focus();
  }, [errors]);

  const change = event => {
    setValue(previous => ({ ...previous, [event.target.name]: event.target.value }));
    setErrors({});
    setDraft(null);
  };
  const invalid = name => ({ 'aria-invalid': errors[name] ? 'true' : undefined, 'aria-describedby': errors[name] ? `wholesale-${name}-error` : undefined });
  const error = name => errors[name] ? <p className="shusha-wholesale-error" id={`wholesale-${name}-error`}>{errors[name]}</p> : null;
  const submit = event => {
    event.preventDefault();
    const result = buildWholesaleDraft(value, { countries, contactUrl, campaign });
    setErrors(result.errors);
    if (Object.keys(result.errors).length) { setDraft(null); return; }
    setDraft(result);
    window.open(result.href, '_blank', 'noopener,noreferrer');
  };

  return (
    <section className="shusha-wholesale" aria-labelledby="shusha-wholesale-title">
      <div className="shusha-wholesale-hero">
        <div className="shusha-wholesale-intro">
          <p className="shusha-wholesale-eyebrow">For independent fashion sellers</p>
          <h1 id="shusha-wholesale-title">Your next collection<br />starts here.</h1>
          <p className="shusha-wholesale-lead">Clothing from Sri Lanka for your online store or social shop. Choose your styles, share your buying plan, and talk to our team about a wholesale quotation.</p>
          <ul className="shusha-wholesale-facts">
            <li><Check size={16} aria-hidden="true" />Worldwide enquiries</li>
            <li><Check size={16} aria-hidden="true" />Dispatch from Sri Lanka</li>
            <li><Check size={16} aria-hidden="true" />Personal quotation support</li>
          </ul>
          <div className="shusha-wholesale-collections">
            <span>Explore the collection</span>
            <a href="/dresses">Dresses<ArrowUpRight size={15} aria-hidden="true" /></a>
            <a href="/tops">Tops<ArrowUpRight size={15} aria-hidden="true" /></a>
            <a href="/pants">Pants<ArrowUpRight size={15} aria-hidden="true" /></a>
          </div>
          <p className="shusha-wholesale-reference">Product-page prices are retail reference prices. Minimum quantities, supply prices, availability and shipping are confirmed for each wholesale enquiry.</p>
        </div>

        <div className="shusha-wholesale-form-card">
          <span className="shusha-wholesale-eyebrow">Tell us what you have in mind</span>
          <h2>Request a wholesale quote</h2>
          <p>Send your country, style codes and estimated quantities. We will review your request personally.</p>
          <form ref={form} onSubmit={submit} noValidate method="post" action="/wholesale">
            <fieldset disabled={!clientReady || !available}>
              <legend className="shusha-wholesale-sr-only">Your wholesale enquiry</legend>
            <div className="shusha-wholesale-field-row">
              <div className="shusha-wholesale-field">
                <label htmlFor="wholesale-country">Destination country <span aria-hidden="true">*</span></label>
                <select id="wholesale-country" name="country" value={value.country} onChange={change} required {...invalid('country')}>
                  <option value="">Choose a country</option>
                  {countries.map(country => <option key={country.code} value={country.code}>{country.name}</option>)}
                </select>
                {error('country')}
              </div>
              <div className="shusha-wholesale-field">
                <label htmlFor="wholesale-sales-channel">Selling channel <span aria-hidden="true">*</span></label>
                <select id="wholesale-sales-channel" name="salesChannel" value={value.salesChannel} onChange={change} required {...invalid('salesChannel')}>
                  <option value="">Choose a channel</option>
                  {WHOLESALE_CHANNELS.map(channel => <option key={channel.value} value={channel.value}>{channel.label}</option>)}
                </select>
                {error('salesChannel')}
              </div>
            </div>
            <div className="shusha-wholesale-field">
              <label htmlFor="wholesale-items">Styles / SKUs and estimated quantities <span aria-hidden="true">*</span></label>
              <textarea id="wholesale-items" name="items" rows={4} maxLength={1200} value={value.items} onChange={change} required placeholder={'Example: L1361, dark gray, L — 10 pieces\nL1360, dark brown, XL — 6 pieces'} {...invalid('items')} />
              <p className="shusha-wholesale-field-hint">Include colours and sizes if you know them. These examples are not minimum order quantities.</p>
              {error('items')}
            </div>
            <div className="shusha-wholesale-field">
              <label htmlFor="wholesale-shop-url">Shop or social profile link <span className="shusha-wholesale-optional">(optional)</span></label>
              <input id="wholesale-shop-url" name="shopUrl" type="url" maxLength={500} value={value.shopUrl} onChange={change} placeholder="https://" {...invalid('shopUrl')} />
              {error('shopUrl')}
            </div>
            <p className="shusha-wholesale-consent" id="wholesale-draft-notice">This opens a WhatsApp draft for SHUSHA. Review the text and press Send in WhatsApp when you are ready. This enquiry does not place an order or request payment.</p>
            {!available && <p role="status" className="shusha-wholesale-error">Quote requests are temporarily unavailable here. Please <a href="/contact">contact our team</a>.</p>}
            {errors.form && <p role="alert" className="shusha-wholesale-error">{errors.form}</p>}
            <button className="shusha-wholesale-submit" type="submit" disabled={!clientReady || !available} aria-describedby="wholesale-draft-notice"><BrandIcon brand="whatsapp" size={21} /><span>Request a wholesale quote</span><ArrowUpRight size={17} aria-hidden="true" /></button>
            </fieldset>
            <noscript><p className="shusha-wholesale-consent">Enable JavaScript to prepare a WhatsApp draft, or <a href="/contact">contact our team</a>.</p></noscript>
            {draft && <div className="shusha-wholesale-draft" role="status"><p>Your draft is ready. If WhatsApp did not open, <a href={draft.href} target="_blank" rel="noopener noreferrer">open the draft here</a>.</p><details><summary>Review enquiry text</summary><pre>{draft.message}</pre></details></div>}
          </form>
        </div>
      </div>

      <div className="shusha-wholesale-next" aria-label="How wholesale enquiries work">
        <article><span className="shusha-wholesale-step">01</span><Layers size={22} aria-hidden="true" /><h2>Choose your styles</h2><p>Browse dresses, tops and pants. Keep the style codes for the pieces you would like to source.</p></article>
        <article><span className="shusha-wholesale-step">02</span><MessageCircle size={22} aria-hidden="true" /><h2>Share your buying plan</h2><p>Tell us your destination, selling channel and estimated quantities so our team can review the options.</p></article>
        <article><span className="shusha-wholesale-step">03</span><Check size={22} aria-hidden="true" /><h2>Review your quotation</h2><p>Confirm available items, minimum quantities, supply prices and delivery costs with our team before payment.</p></article>
      </div>
      <div className="shusha-wholesale-contact"><div><p className="shusha-wholesale-eyebrow">A real conversation, from the start</p><h2>Meet your sourcing contact.</h2><p>SHUSHA supports worldwide enquiries from Sri Lanka. Our team handles quotation and follow-up personally.</p><a href="/contact">Contact SHUSHA<ArrowUpRight size={16} aria-hidden="true" /></a></div><MerchantContactCard publicMerchantProfile={publicMerchantProfile} /></div>
    </section>
  );
}

export const layout = { areaId: 'content', sortOrder: 10 };
export const query = `
  query Query {
    countries { code name }
    publicMerchantProfile {
      shopName legalName
      address { line1 line2 city postalCode country }
      support { email whatsappSriLanka whatsappChina }
    }
  }
`;
