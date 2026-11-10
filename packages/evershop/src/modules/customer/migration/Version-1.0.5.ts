import { execute, type PoolClient } from '@evershop/postgres-query-builder';

// Backport the upstream password-field exclusion to the 2.2.1 migration chain.
export default async (connection: PoolClient) => {
  for (const [fn, eventName, row] of [
    ['add_customer_created_event', 'customer_created', 'NEW'],
    ['add_customer_updated_event', 'customer_updated', 'NEW'],
    ['add_customer_deleted_event', 'customer_deleted', 'OLD']
  ]) {
    await execute(
      connection,
      `CREATE OR REPLACE FUNCTION ${fn}() RETURNS TRIGGER AS $$
      BEGIN
        INSERT INTO event (name, data)
        VALUES ('${eventName}', (to_jsonb(${row}) - 'password')::json);
        RETURN ${row};
      END;
      $$ LANGUAGE plpgsql;`
    );
  }
};
