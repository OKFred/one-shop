
import { configurationReadiness } from '../../../services/receivingConfig.js';
import { invoiceReference } from '../../../services/paypalInvoices.js';

export default {
  Query: { bankTransferReceivingConfig: () => configurationReadiness() },
  BankTransferQuote: { paypalInvoiceReference: (quote) => invoiceReference(quote) }
};
