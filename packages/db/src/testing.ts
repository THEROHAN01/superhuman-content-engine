import { createPool, type Db } from './pool.js';
import { migrate } from './migrate.js';

/**
 * Test harness for database-backed tests.
 *
 * Each test file gets its own PostgreSQL schema, migrated from scratch and dropped afterwards, so
 * suites never see each other's rows and can run in any order. When no test database is
 * configured the suite is *skipped*, never faked - a green run with no database must be visibly
 * green-with-skips.
 */

export const testDatabaseUrl = (): string | undefined =>
  process.env['TEST_DATABASE_URL'] ?? undefined;

export const hasTestDatabase = (): boolean => testDatabaseUrl() !== undefined;

export interface TestDb {
  db: Db;
  schema: string;
  /** Truncates every table, keeping the schema. Cheaper than re-migrating between tests. */
  truncate: () => Promise<void>;
  close: () => Promise<void>;
}

const sanitize = (name: string): string =>
  `t_${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 40)}_${process.pid}`;

export const createTestDb = async (name: string): Promise<TestDb> => {
  const connectionString = testDatabaseUrl();
  if (!connectionString) throw new Error('TEST_DATABASE_URL is not set');

  const schema = sanitize(name);

  // Bootstrap connection: create the schema before any pooled connection sets search_path to it.
  const bootstrap = createPool({ connectionString, max: 1, applicationName: 'sce-test-bootstrap' });
  await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  await bootstrap.end();

  // search_path is set by the server through the connection's `options` parameter, so every
  // pooled client lands in this schema without an extra round trip or a connect handler.
  const scoped = new URL(connectionString);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = createPool({
    connectionString: scoped.toString(),
    max: 4,
    applicationName: `sce-test-${schema}`,
  });
  await migrate(db);

  const tables = async (): Promise<string[]> => {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> 'schema_migrations'`,
      [schema],
    );
    return rows.map((r) => r.tablename);
  };

  return {
    db,
    schema,
    async truncate() {
      const names = await tables();
      if (names.length === 0) return;
      await db.query(
        `TRUNCATE ${names.map((t) => `${schema}.${t}`).join(', ')} RESTART IDENTITY CASCADE`,
      );
    },
    async close() {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    },
  };
};
