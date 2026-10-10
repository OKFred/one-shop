import { createAdminPaymentHandler } from '../../services/paymentHttp.js';
import { paymentRuntime } from '../../services/paymentRuntime.js';
export default createAdminPaymentHandler({ getRuntime: paymentRuntime });
