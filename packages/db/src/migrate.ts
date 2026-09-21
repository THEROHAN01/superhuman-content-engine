import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';
import { withTransaction } from './pool.js';

/**
 * Forward-only SQL migrations.
 *
 * Each file runs exactly once, inside a transaction, and its checksum is recorded. Editing an
 * applied migration is a mistake the runner refuses to paper over: it aborts and tells you to add
 * a new migration instead.
 */

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const loadMigrations = (dir: string = MIGRATIONS_DIR): Migration[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        name: file,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
      };
    });

const ensureMigrationsTable = async (db: Db): Promise<void> => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum   TEXT NOT NULL
    )`);
};

export interface MigrationStatus {
  version: string;
  applied: boolean;
  appliedAt: string | null;
  checksumMatches: boolean;
}

export const migrationStatus = async (
  db: Db,
  migrations: Migration[] = loadMigrations(),
): Promise<MigrationStatus[]> => {
  await ensureMigrationsTable(db);
  const { rows } = await db.query<{ version: string; applied_at: string; checksum: string }>(
    'SELECT version, applied_at, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.version, r]));
  return migrations.map((m) => {
    const record = applied.get(m.version);
    return {
      version: m.version,
      applied: record !== undefined,
      appliedAt: record?.applied_at ?? null,
      checksumMatches: record === undefined ? true : record.checksum === m.checksum,
    };
  });
};

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export const migrate = async (
  db: Db,
  migrations: Migration[] = loadMigrations(),
): Promise<MigrateResult> => {
  await ensureMigrationsTable(db);
  const status = await migrationStatus(db, migrations);

  const drifted = status.filter((s) => s.applied && !s.checksumMatches);
  if (drifted.length > 0) {
    throw new Error(
      `migration files changed after being applied: ${drifted
        .map((d) => d.version)
        .join(', ')}. Migrations are forward-only - add a new migration instead of editing one.`,
    );
  }

  const result: MigrateResult = { applied: [], skipped: [] };
  for (const migration of migrations) {
    const record = status.find((s) => s.version === migration.version);
    if (record?.applied) {
      result.skipped.push(migration.version);
      continue;
    }
    await withTransaction(db, async (client) => {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [migration.version, migration.checksum],
      );
    });
    result.applied.push(migration.version);
  }
  return result;
};
