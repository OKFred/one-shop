import { createCustomerPaymentPage } from '../../../services/paymentHttp.js';
import { paymentRuntime } from '../../../services/paymentRuntime.js';
export default createCustomerPaymentPage({ getRuntime: paymentRuntime });
