import { jest, describe, it, expect } from '@jest/globals';

const execute = jest.fn(async () => {});
jest.unstable_mockModule('@evershop/postgres-query-builder', () => ({
  execute
}));
const { default: migrate } = await import('../../migration/Version-1.0.5.js');

describe('customer event password-field migration', () => {
  it('replaces only the three existing trigger functions and excludes the password for every operation', async () => {
    const connection = {};
    await migrate(connection);
    expect(execute).toHaveBeenCalledTimes(3);
    const expected = [
      ['created', 'NEW'],
      ['updated', 'NEW'],
      ['deleted', 'OLD']
    ];
    for (const [index, [operation, row]] of expected.entries()) {
      const [conn, sql] = execute.mock.calls[index];
      expect(conn).toBe(connection);
      expect(sql.trim()).toMatch(
        new RegExp(
          `^CREATE OR REPLACE FUNCTION add_customer_${operation}_event\\(\\)`
        )
      );
      expect(sql).toContain(
        `VALUES ('customer_${operation}', (to_jsonb(${row}) - 'password')::json)`
      );
      expect(sql).toContain(`RETURN ${row};`);
      // Replacing functions must not replace triggers or rewrite stored rows.
      expect(sql).not.toMatch(
        /\b(?:DROP|ALTER|CREATE TRIGGER|UPDATE|DELETE FROM)\b/i
      );
    }
  });
});
