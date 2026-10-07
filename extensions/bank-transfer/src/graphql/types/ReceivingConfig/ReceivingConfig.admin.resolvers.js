
import { configurationReadiness } from '../../../services/receivingConfig.js';
export default { Query: { bankTransferReceivingConfig: () => configurationReadiness() } };
