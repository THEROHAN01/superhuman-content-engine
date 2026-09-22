import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, hasTestDatabase, type TestDb } from './testing.js';
import { loadMigrations, migrate, migrationStatus } from './migrate.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('migrations against a real database', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await createTestDb('migrations');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('creates every core table', async () => {
    const { rows } = await ctx.db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      [ctx.schema],
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      'analytics_events',
      'approvals',
      'content_atoms',
      'content_ideas',
      'content_items',
      'error_events',
      'jobs',
      'learning_events',
      'publications',
      'schema_migrations',
      'source_documents',
      'webhook_deliveries',
      'weekly_reports',
      'workflow_runs',
    ]);
  });

  it('is idempotent - re-running applies nothing', async () => {
    const again = await migrate(ctx.db);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
  });

  it('records each migration with a checksum', async () => {
    const status = await migrationStatus(ctx.db);
    expect(status.every((s) => s.applied && s.checksumMatches)).toBe(true);
  });

  it('refuses to run when an applied migration file has been edited', async () => {
    const tampered = loadMigrations().map((m) => ({ ...m, checksum: 'deadbeefdeadbeef' }));
    await expect(migrate(ctx.db, tampered)).rejects.toThrow(/forward-only/);
  });

  it('creates the indexes the query paths depend on', async () => {
    const { rows } = await ctx.db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [ctx.schema],
    );
    const indexes = rows.map((r) => r.indexname);
    for (const expected of [
      'learning_events_content_hash_key',
      'learning_events_source_external_key',
      'learning_events_status_idx',
      'content_atoms_learning_event_key',
      'content_ideas_atom_dedupe_key',
      'content_items_idea_format_version_key',
      'approvals_action_id_key',
      'publications_idempotency_key',
      'publications_status_schedule_idx',
      'analytics_events_collection_key',
      'jobs_active_dedupe_key',
      'webhook_deliveries_provider_delivery_key',
      'weekly_reports_period_key',
    ]) {
      expect(indexes, `missing index ${expected}`).toContain(expected);
    }
  });

  it('maintains updated_at through a trigger', async () => {
    await ctx.db.query(
      `INSERT INTO learning_events (id, source, raw_text, content_hash, correlation_id)
       VALUES ('le_trigger', 'manual', 'trigger probe text', repeat('a', 64), 'cor_t')`,
    );
    const before = await ctx.db.query<{ updated_at: string }>(
      `SELECT updated_at FROM learning_events WHERE id = 'le_trigger'`,
    );
    await new Promise((r) => setTimeout(r, 15));
    await ctx.db.query(`UPDATE learning_events SET title = 'changed' WHERE id = 'le_trigger'`);
    const after = await ctx.db.query<{ updated_at: string }>(
      `SELECT updated_at FROM learning_events WHERE id = 'le_trigger'`,
    );
    expect(new Date(after.rows[0]!.updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0]!.updated_at).getTime(),
    );
    await ctx.db.query(`DELETE FROM learning_events WHERE id = 'le_trigger'`);
  });
});
