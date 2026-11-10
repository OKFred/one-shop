import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let enabled;
const sendEmail = jest.fn(async () => {});
const getValue = jest.fn(async (_key, value) => value);
const error = jest.fn();
jest.unstable_mockModule('../../../../lib/helpers.js', () => ({
  CONSTANTS: { ROOTPATH: '/synthetic' }
}));
jest.unstable_mockModule(
  '../../../../lib/locale/translate/translate.js',
  () => ({
    translate: (text) => text
  })
);
jest.unstable_mockModule('../../../../lib/log/logger.js', () => ({
  debug: jest.fn(),
  error
}));
jest.unstable_mockModule('../../../../lib/mail/emailHelper.js', () => ({
  buildEmailBodyFromTemplate: jest.fn(),
  sendEmail
}));
jest.unstable_mockModule('../../../../lib/util/getConfig.js', () => ({
  getConfig: () => ({ enabled })
}));
jest.unstable_mockModule('../../../../lib/util/registry.js', () => ({
  getValue
}));
jest.unstable_mockModule('../../../setting/services/setting.js', () => ({
  getStoreLanguage: async () => 'en'
}));
const { default: welcome } = await import(
  '../../subscribers/customer_registered/sendWelcomeEmail.js'
);

describe('welcome event boundary', () => {
  beforeEach(() => {
    enabled = true;
    jest.clearAllMocks();
  });

  it.each([true, false])(
    'removes legacy password data (legacy=%s) from both hook boundaries',
    async (legacy) => {
      const data = Object.freeze({
        email: 'synthetic@example.invalid',
        full_name: 'Synthetic fixture',
        meta_data: { fixture: true },
        ...(legacy ? { password: 'synthetic-password-hash' } : {})
      });
      await welcome(data);
      const customer = getValue.mock.calls[0][1].customer;
      expect(customer).not.toHaveProperty('password');
      expect(customer).toEqual({
        email: 'synthetic@example.invalid',
        full_name: 'Synthetic fixture',
        meta_data: { fixture: true }
      });
      expect(getValue.mock.calls[0][0]).toBe('customerWelcomeEmailData');
      expect(getValue.mock.calls[1][0]).toBe('customerWelcomeEmailArguments');
      expect(getValue.mock.calls[1][2]).toEqual({ customer });
      expect(sendEmail).toHaveBeenCalledWith(
        'customer_welcome',
        expect.objectContaining({
          to: 'synthetic@example.invalid',
          data: { customer },
          locale: 'en'
        })
      );
      if (legacy) expect(data.password).toBe('synthetic-password-hash');
    }
  );

  it('keeps disabled welcome notifications outside hooks and the email boundary', async () => {
    enabled = false;
    await welcome(undefined);
    expect(getValue).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
