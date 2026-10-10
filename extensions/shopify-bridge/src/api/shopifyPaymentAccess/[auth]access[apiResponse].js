import { createCustomerPaymentHandler } from '../../services/paymentHttp.js';
import { paymentRuntime } from '../../services/paymentRuntime.js';
export default createCustomerPaymentHandler({ getRuntime: paymentRuntime });
