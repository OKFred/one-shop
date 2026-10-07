
import { DEFAULTS } from '../../../services/settings.js';

export default {
  Setting: Object.fromEntries(Object.entries(DEFAULTS).filter(([name]) => !['bankTransferBankName', 'bankTransferBeneficiary', 'bankTransferAccount', 'bankTransferSwift'].includes(name)).map(([name, fallback]) => [name, (setting) => {
    const value = setting.find((row) => row.name === name)?.value ?? fallback;
    return name === 'bankTransferPaymentStatus' ? (String(value) === '1' ? 1 : 0) : value;
  }]))
};
