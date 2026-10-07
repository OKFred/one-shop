import config from 'config';
import { getConfig } from '@evershop/evershop/lib/util/getConfig';

export const AUTOMATIC_CUSTOMER_EMAIL_TYPES = Object.freeze([
  'order_confirmation', 'customer_welcome', 'shipment_created', 'shipment_delivered'
]);

// EverShop v2 has no subscriber-list registry or override. Its own customer
// notification subscribers support this explicit enabled=false guard, before
// preparing a message or resolving an email provider. Keep the event machinery
// and stock/catalog subscribers intact; do not install a pretend mail service.
export function installAutomaticEmailPolicy() {
  config.util.setModuleDefaults('system.notification_emails', Object.fromEntries(
    AUTOMATIC_CUSTOMER_EMAIL_TYPES.map(type => [type, { enabled: false }])
  ));
  for (const type of AUTOMATIC_CUSTOMER_EMAIL_TYPES) {
    if (getConfig(`system.notification_emails.${type}.enabled`) !== false) {
      throw new Error('SHUSHA automatic customer email notifications must be disabled');
    }
  }
}
