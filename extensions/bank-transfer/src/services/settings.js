
import { getSetting } from '@evershop/evershop/setting/services';

const DEFAULTS = Object.freeze({
  bankTransferPaymentStatus: '0',
  bankTransferDisplayName: 'T/T Bank Transfer — payment after confirmation',
  bankTransferBankName: 'To be confirmed',
  bankTransferBeneficiary: 'To be confirmed',
  bankTransferAccount: 'To be confirmed',
  bankTransferSwift: 'To be confirmed',
  bankTransferContactSriLanka: '+94 77 636 9425',
  bankTransferContactChina: '+86 15757106234'
});
async function isEnabled() {
  return String(await getSetting('bankTransferPaymentStatus', DEFAULTS.bankTransferPaymentStatus)) === '1';
}
async function displayName() {
  return getSetting('bankTransferDisplayName', DEFAULTS.bankTransferDisplayName);
}
export { DEFAULTS, isEnabled, displayName };
