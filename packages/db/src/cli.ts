/**
 * Database CLI: `pnpm db:migrate | db:status | db:seed | db:reset`.
 * Kept dependency-free so it can run before the application is built.
 */
import { createPool, type Db } from './pool.js';
import { loadMigrations, migrate, migrationStatus } from './migrate.js';
import { removeSeedData, seed } from './seed.js';

const command = process.argv[2] ?? 'status';
const args = new Set(process.argv.slice(3));

const run = async (fn: (db: Db) => Promise<void>): Promise<void> => {
  const db = createPool({ applicationName: 'sce-db-cli' });
  try {
    await fn(db);
  } finally {
    await db.end();
  }
};

const commands: Record<string, () => Promise<void>> = {
  async migrate() {
    await run(async (db) => {
      const result = await migrate(db);
      console.log(
        result.applied.length > 0
          ? `applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`
          : 'database already up to date',
      );
      if (result.skipped.length > 0)
        console.log(`skipped ${result.skipped.length} already applied`);
    });
  },

  async status() {
    await run(async (db) => {
      const status = await migrationStatus(db, loadMigrations());
      for (const m of status) {
        const state = m.applied
          ? m.checksumMatches
            ? 'applied'
            : 'APPLIED BUT CHANGED'
          : 'pending';
        console.log(`${m.version.padEnd(40)} ${state}${m.appliedAt ? `  ${m.appliedAt}` : ''}`);
      }
    });
  },

  async seed() {
    await run(async (db) => {
      if (args.has('--remove')) {
        const removed = await removeSeedData(db);
        console.log(`removed ${removed} seed row(s)`);
        return;
      }
      const result = await seed(db);
      console.log(
        `seed: ${result.created.length} created, ${result.existing.length} already present`,
      );
    });
  },

  /**
   * Destructive: drops the public schema and rebuilds it from migrations.
   * Refuses without --force, and refuses outright on a database that is not clearly local/test.
   */
  async reset() {
    const url = process.env['DATABASE_URL'] ?? '';
    const isLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url);
    const isTestDb = /_(test|dev|check)(\?|$)/.test(url);
    if (!args.has('--force')) {
      console.error('refusing to reset without --force (this drops every table and all data)');
      process.exit(1);
    }
    if (!isLocal && !isTestDb) {
      console.error(
        `refusing to reset ${url.replace(/:\/\/[^@]*@/, '://***@')}: not a local or test database`,
      );
      process.exit(1);
    }
    await run(async (db) => {
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      const result = await migrate(db);
      console.log(`reset complete; applied ${result.applied.length} migration(s)`);
    });
  },
};

const handler = commands[command];
if (!handler) {
  console.error(
    `unknown command: ${command}\nusage: migrate | status | seed [--remove] | reset --force`,
  );
  process.exit(1);
}

handler().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
