import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Synthetic service boundaries: no database, password hashing or event dispatch.
const connection = {};
let operations;
const startTransaction = jest.fn(async () => operations.push('begin'));
const commit = jest.fn(async () => operations.push('commit'));
const rollback = jest.fn(async () => operations.push('rollback'));
const emit = jest.fn(async () => operations.push('emit'));
const inserted = jest.fn(async (data) => ({ customer_id: 1, ...data }));
jest.unstable_mockModule('@evershop/postgres-query-builder', () => ({
  startTransaction,
  commit,
  rollback,
  select: () => ({
    from: () => ({ where: () => ({ load: async () => null }) })
  }),
  insert: () => ({
    given: (data) => ({
      execute: async (conn) => {
        expect(conn).toBe(connection);
        return inserted(data);
      }
    })
  })
}));
jest.unstable_mockModule('../../../../lib/postgres/connection.js', () => ({
  getConnection: async () => connection,
  pool: {}
}));
jest.unstable_mockModule('../../../../lib/event/emitter.js', () => ({ emit }));
jest.unstable_mockModule('../../../../lib/util/passwordHelper.js', () => ({
  verifyPassword: () => {},
  hashPassword: () => 'synthetic-password-hash'
}));
jest.unstable_mockModule('../../../../lib/util/registry.js', () => ({
  getValue: async (_key, value) => value,
  getValueSync: (_key, value) => value
}));
jest.unstable_mockModule('../../../base/services/getAjv.js', () => ({
  getAjv: () => ({ compile: () => () => true })
}));
const { clearHooks } = await import('../../../../lib/util/hookable.js');
const {
  default: createCustomer,
  hookAfterCreateCustomer,
  hookAfterInsertCustomerData
} = await import('../../services/customer/createCustomer.js');

describe('customer creation event payloads', () => {
  beforeEach(() => {
    operations = [];
    jest.clearAllMocks();
    clearHooks();
  });

  it.each([
    [1, 'customer_registered'],
    [0, 'account_created']
  ])(
    'omits the password from status %i events and preserves service/hook results',
    async (status, eventName) => {
      let insertedRow;
      const afterCreate = jest.fn();
      hookAfterInsertCustomerData((row) => {
        insertedRow = row;
      });
      hookAfterCreateCustomer(afterCreate);
      const result = await createCustomer(
        {
          email: 'synthetic@example.invalid',
          full_name: 'Synthetic fixture',
          password: 'synthetic-input',
          status,
          meta_data: { fixture: true }
        },
        { fixtureContext: true }
      );
      const [name, payload] = emit.mock.calls[0];
      expect(name).toBe(eventName);
      expect(payload).not.toHaveProperty('password');
      expect(payload).toEqual({
        customer_id: 1,
        email: 'synthetic@example.invalid',
        full_name: 'Synthetic fixture',
        status,
        group_id: 1,
        meta_data: { fixture: true }
      });
      expect(result).toBe(insertedRow);
      expect(result.password).toBe('synthetic-password-hash');
      expect(afterCreate.mock.calls[0][0]).toBe(result);
      expect(payload).not.toBe(result);
      // Keep 2.2.1's existing event call and transaction ordering unchanged.
      expect(emit.mock.calls[0]).toHaveLength(2);
      expect(operations).toEqual(['begin', 'emit', 'commit']);
    }
  );

  it('keeps the existing rollback when the event boundary fails', async () => {
    emit.mockRejectedValueOnce(new Error('Synthetic event failure'));
    await expect(
      createCustomer({
        email: 'synthetic@example.invalid',
        full_name: 'Synthetic fixture',
        password: 'synthetic-input'
      })
    ).rejects.toThrow('Synthetic event failure');
    expect(rollback).toHaveBeenCalledWith(connection);
    expect(commit).not.toHaveBeenCalled();
  });
});
