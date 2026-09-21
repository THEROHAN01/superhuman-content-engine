import pg from 'pg';
import { getEnv } from '@sce/utils';

const { Pool, types } = pg;
export type { PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Return timestamptz as ISO strings rather than JS Dates: every boundary in this system speaks
 * ISO-8601 UTC, and node-postgres' Date parsing silently applies the process timezone.
 */
types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
types.setTypeParser(1114, (value: string) => new Date(`${value}Z`).toISOString());
// DATE stays a plain YYYY-MM-DD string.
types.setTypeParser(1082, (value: string) => value);
// int8 counts: safe to Number() for this system's volumes, and much easier to work with.
types.setTypeParser(20, (value: string) => Number(value));

export interface DbOptions {
  connectionString?: string;
  max?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

export type Db = pg.Pool;

export const createPool = (options: DbOptions = {}): Db => {
  const env = (() => {
    try {
      return getEnv();
    } catch {
      return undefined;
    }
  })();

  const connectionString =
    options.connectionString ?? env?.DATABASE_URL ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to create a database pool');
  }

  return new Pool({
    connectionString,
    max: options.max ?? env?.DATABASE_POOL_MAX ?? 10,
    application_name: options.applicationName ?? 'sce',
    statement_timeout: options.statementTimeoutMs ?? env?.DATABASE_STATEMENT_TIMEOUT_MS ?? 15_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
};

/** Runs `fn` inside a transaction, rolling back on any throw. */
export const withTransaction = async <T>(
  db: Db,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

/** True when an error is a unique-constraint violation (used for idempotent inserts). */
export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';

export const isCheckViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23514';

export const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503';
