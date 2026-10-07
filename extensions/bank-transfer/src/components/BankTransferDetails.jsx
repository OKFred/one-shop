import React from 'react';
import PropTypes from 'prop-types';
import BrandIcon from './BrandIcon.js';

export function BankTransferContacts({ setting }) {
  const contacts = [setting.bankTransferContactSriLanka, setting.bankTransferContactChina].filter(Boolean);
  return (
      <div>
        <p>Contact SHUSHA and quote your order number:</p>
        <ul>{contacts.map((number) => {
          const digits = number.replace(/\D/g, '');
          const link = /^\d{8,15}$/.test(digits) ? `https://wa.me/${digits}` : undefined;
          return <li key={number}>{link ? <a href={link} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><BrandIcon brand="whatsapp" /><span>{number} (WhatsApp)</span></a> : number}</li>;
        })}</ul>
      </div>
  );
}

export function BankTransferDetails({ setting }) {
  return (
    <div className="bank-transfer-instructions space-y-4">
      <p><strong>Our team confirms availability and the amount to pay before payment.</strong></p>
      <p>Submit your order request first. SHUSHA ships from Sri Lanka. Shipping is not included in the amount shown and will be arranged separately.</p>
      <p>Once your order is confirmed, you will receive a payment page with a Wise payment button and bank transfer instructions.</p>
      <p><strong>Please wait for confirmed payment instructions before sending money.</strong></p>
      <BankTransferContacts setting={setting} />
    </div>
  );
}

BankTransferDetails.propTypes = { setting: PropTypes.shape({
  bankTransferContactSriLanka: PropTypes.string,
  bankTransferContactChina: PropTypes.string
}).isRequired };
BankTransferContacts.propTypes = BankTransferDetails.propTypes;
