
import { DEFAULTS } from '../../../services/settings.js';
import { paypalInvoicesEnabled } from '../../../services/paypalInvoices.js';

export default {
  Setting: {
    bankTransferPaypalEnabled: () => paypalInvoicesEnabled(),
    ...Object.fromEntries(Object.entries(DEFAULTS).filter(([name]) => !['bankTransferBankName', 'bankTransferBeneficiary', 'bankTransferAccount', 'bankTransferSwift'].includes(name)).map(([name, fallback]) => [name, (setting) => {
      const value = setting.find((row) => row.name === name)?.value ?? fallback;
      return name === 'bankTransferPaymentStatus' ? (String(value) === '1' ? 1 : 0) : value;
    }]))
  }
};
