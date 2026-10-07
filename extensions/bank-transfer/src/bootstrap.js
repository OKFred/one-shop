import { addProcessor } from '@evershop/evershop/lib/util/registry';
import { getConfig } from '@evershop/evershop/lib/util/getConfig';
import { registerShippingProvider, registerPaymentMethod, hookBeforeSaveOrder, hookBeforeSaveShippingAddress } from '@evershop/evershop/checkout/services';
import { resolveOrderStatus } from '@evershop/evershop/oms/services';
import { provinces } from '@evershop/evershop/lib/locale/provinces';
import { isEnabled, displayName } from './services/settings.js';
import { manualQuoteProvider, PROVIDER_CODE, CODE, validateQuoteAddress } from './services/manualQuote.js';
import { installAutomaticEmailPolicy } from './services/automaticEmails.js';

export default () => {
  installAutomaticEmailPolicy();
  registerShippingProvider(manualQuoteProvider);
  registerPaymentMethod({
    init: async () => ({ code: 'banktransfer', name: await displayName() }),
    validator: async () => isEnabled()
  });

  // Keep other providers installed for admin/recovery, but suppress their
  // quotes while the store operates in manual shipping confirmation mode.
  addProcessor('shippingProviders', (providers) => providers.map((provider) => {
    if (provider.code === PROVIDER_CODE) return provider;
    return {
      ...provider,
      getMethods: async (context) => (await isEnabled()) ? [] : provider.getMethods(context),
      validateMethod: async (context, code) => {
        if (await isEnabled()) return null;
        return provider.validateMethod ? provider.validateMethod(context, code) : (await provider.getMethods(context)).find((method) => method.code === code) || null;
      }
    };
  }), 900);
  addProcessor('checkoutPaymentMethods', (methods) => methods.map((factory) => ({
    ...factory,
    validator: async (context) => {
      const info = await factory.init();
      if (await isEnabled()) return info.code === 'banktransfer' && (!factory.validator || await factory.validator(context));
      return info.code !== 'banktransfer' && (!factory.validator || await factory.validator(context));
    }
  })), 900);

  // Province is optional for countries without a province catalogue. Keep
  // the native validation manager and the native address transaction intact.
  addProcessor('addressValidator', (manager) => {
    manager.add({ id: 'provinceNotEmpty', func: (address) => !provinces.some((p) => p.countryCode === address.country) || typeof address.province === 'string' && !!address.province.trim(), errorMessage: 'Province is required' });
    return manager;
  }, 900);
  hookBeforeSaveShippingAddress(async (address) => {
    if (await isEnabled()) validateQuoteAddress(address);
  });
  hookBeforeSaveOrder(async (cart) => {
    if (!(await isEnabled())) return;
    if (cart.getData('payment_method') !== 'banktransfer') throw new Error('Select T/T payment after confirmation');
    const shipping = cart.getData('shipping_method_data');
    if (shipping?.provider_code !== PROVIDER_CODE || shipping?.method_code !== CODE) throw new Error('T/T order requests require manual shipping quotation');
    validateQuoteAddress(cart.getData('shipping_address'));
    const states = getConfig('oms.order.paymentStatus', {});
    const defaults = Object.keys(states).filter((key) => states[key].isDefault);
    if (defaults.length !== 1 || defaults[0] !== 'pending') throw new Error('T/T orders require native pending payment default');
    if (!['new', 'pending'].includes(resolveOrderStatus('pending', 'pending'))) throw new Error('T/T orders require a pending/new native order state');
    for (const key of ['shipping_fee_excl_tax', 'shipping_fee_incl_tax']) {
      if (Number(cart.getData(key)) !== 0) throw new Error('A quotation request must not include an unconfirmed shipping charge');
    }
    if (cart.getData('currency') !== 'USD') throw new Error('SHUSHA merchandise orders require USD');
  });
};
