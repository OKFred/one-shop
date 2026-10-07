
import fs from 'node:fs';
import { openLink } from './paymentValidation.js';

function loadReceivingConfig() {
  const file = process.env.SHUSHA_WISE_RECEIVING_CONFIG;
  if (!file) return { openLink: null, accounts: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const accounts = {};
  for (const code of ['GBP', 'EUR', ...(raw.allowUsd === true ? ['USD'] : [])]) {
    const account = raw.accounts?.[code];
    if (!account) continue;
    if (!Array.isArray(account.fields) || !account.fields.length || account.fields.length > 16) throw new Error('Receiving account configuration has invalid fields');
    const fields = account.fields.map((field) => {
      if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 80 || typeof field.value !== 'string' || !field.value.trim() || field.value.length > 500 || /to be confirmed|placeholder/i.test(field.value)) throw new Error('Receiving account configuration is incomplete');
      return { label: field.label.trim(), value: field.value.trim() };
    });
    accounts[code] = { fields };
  }
  return { openLink: openLink(raw.openLink), accounts };
}
function configurationReadiness() {
  try {
    const config = loadReceivingConfig();
    const currencies = Object.keys(config.accounts);
    return { ready: currencies.length > 0, currencies, openLinkReady: !!config.openLink };
  } catch (_) {
    // Never expose private configuration contents or filesystem paths in UI.
    return { ready: false, currencies: [], openLinkReady: false };
  }
}
export { loadReceivingConfig, configurationReadiness };
