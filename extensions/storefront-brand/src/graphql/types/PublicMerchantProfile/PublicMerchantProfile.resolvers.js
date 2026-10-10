import { loadPublicMerchantProfile } from '../../../services/publicProfile.js';

export default {
  Query: {
    publicMerchantProfile: () => loadPublicMerchantProfile()
  }
};
