import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, idempotencyKey } from '@sce/utils';
import { createTestDb, hasTestDatabase, type TestDb } from './testing.js';
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation } from './pool.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

/**
 * These tests exist because application-level deduplication is not a guarantee. Each one proves
 * the database itself rejects the duplicate, so a race between two workers cannot slip through.
 */
describeDb('database constraints', () => {
  let ctx: TestDb;

  const insertEvent = async (id: string, text: string, extra: Record<string, string> = {}) =>
    ctx.db.query(
      `INSERT INTO learning_events (id, source, external_id, raw_text, content_hash, correlation_id)
       VALUES ($1, $2, $3, $4, $5, 'cor_test')`,
      [id, extra['source'] ?? 'manual', extra['external_id'] ?? null, text, contentHash(text)],
    );

  const insertAtom = async (id: string, eventId: string) =>
    ctx.db.query(
      `INSERT INTO content_atoms (id, learning_event_id, title, kind, primary_topic, body, generator_version)
       VALUES ($1, $2, 'Atom', 'core_engineering', 'databases', '{}'::jsonb, 'atom.v1')`,
      [id, eventId],
    );

  beforeAll(async () => {
    ctx = await createTestDb('constraints');
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
  });

  it('rejects a second capture of the same note', async () => {
    await insertEvent('le_1', 'why refresh token rotation matters');
    await expect(insertEvent('le_2', 'Why REFRESH-TOKEN rotation matters!')).rejects.toSatisfy(
      isUniqueViolation,
    );
  });

  it('rejects a repeated provider delivery of the same external id', async () => {
    await insertEvent('le_1', 'first note about redis', {
      source: 'telegram',
      external_id: 'msg-42',
    });
    await expect(
      insertEvent('le_2', 'a completely different note', {
        source: 'telegram',
        external_id: 'msg-42',
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('allows the same external id from a different source', async () => {
    await insertEvent('le_1', 'note one about queues', { source: 'telegram', external_id: 'id-1' });
    await expect(
      insertEvent('le_2', 'note two about caches', { source: 'notion', external_id: 'id-1' }),
    ).resolves.toBeDefined();
  });

  it('rejects an unknown status value', async () => {
    await expect(
      ctx.db.query(
        `INSERT INTO learning_events (id, status, source, raw_text, content_hash, correlation_id)
         VALUES ('le_bad', 'not_a_status', 'manual', 'text here', repeat('b', 64), 'cor')`,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses to mark an event as a duplicate of itself', async () => {
    await insertEvent('le_self', 'self duplicate probe text');
    await expect(
      ctx.db.query(`UPDATE learning_events SET duplicate_of = 'le_self' WHERE id = 'le_self'`),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('requires a duplicate to reference the original', async () => {
    await insertEvent('le_orig', 'original note about indexes');
    await expect(
      ctx.db.query(`UPDATE learning_events SET status = 'duplicate' WHERE id = 'le_orig'`),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('keeps provenance: a learning event with an atom cannot be deleted', async () => {
    await insertEvent('le_p', 'provenance probe note text');
    await insertAtom('ca_p', 'le_p');
    await expect(ctx.db.query(`DELETE FROM learning_events WHERE id = 'le_p'`)).rejects.toSatisfy(
      isForeignKeyViolation,
    );
  });

  it('allows only one canonical atom per learning event', async () => {
    await insertEvent('le_a', 'one atom per event probe');
    await insertAtom('ca_a', 'le_a');
    await expect(insertAtom('ca_b', 'le_a')).rejects.toSatisfy(isUniqueViolation);
  });

  it('rejects a duplicate idea for the same atom', async () => {
    await insertEvent('le_i', 'idea dedupe probe note');
    await insertAtom('ca_i', 'le_i');
    const insertIdea = (id: string) =>
      ctx.db.query(
        `INSERT INTO content_ideas
           (id, content_atom_id, learning_event_id, angle, title, rationale, audience, platforms, formats, hook, dedupe_hash, prompt_version)
         VALUES ($1, 'ca_i', 'le_i', 'insight', 'T', 'R', 'A', ARRAY['x'], ARRAY['x_post'], 'H', $2, 'ideation.v1')`,
        [id, contentHash('same idea')],
      );
    await insertIdea('ci_1');
    await expect(insertIdea('ci_2')).rejects.toSatisfy(isUniqueViolation);
  });

  it('rejects a duplicate publication for the same item, platform and slot', async () => {
    await insertEvent('le_pub', 'publication idempotency probe');
    await insertAtom('ca_pub', 'le_pub');
    await ctx.db.query(
      `INSERT INTO content_ideas (id, content_atom_id, learning_event_id, angle, title, rationale, audience, platforms, formats, hook, dedupe_hash, prompt_version)
       VALUES ('ci_pub', 'ca_pub', 'le_pub', 'insight', 'T', 'R', 'A', ARRAY['x'], ARRAY['x_post'], 'H', $1, 'v1')`,
      [contentHash('pub idea')],
    );
    await ctx.db.query(
      `INSERT INTO content_items (id, content_idea_id, content_atom_id, learning_event_id, platform, format, draft, prompt_id, prompt_version, model, correlation_id)
       VALUES ('it_pub', 'ci_pub', 'ca_pub', 'le_pub', 'x', 'x_post', '{}'::jsonb, 'x_post', 'v1', 'mock', 'cor')`,
    );

    const key = idempotencyKey('it_pub', 'x', '2026-09-22T09:00:00.000Z');
    const publish = (id: string) =>
      ctx.db.query(
        `INSERT INTO publications (id, content_item_id, learning_event_id, platform, idempotency_key, provider, scheduled_at, correlation_id)
         VALUES ($1, 'it_pub', 'le_pub', 'x', $2, 'mock', '2026-09-22T09:00:00Z', 'cor')`,
        [id, key],
      );
    await publish('pb_1');
    await expect(publish('pb_2')).rejects.toSatisfy(isUniqueViolation);
  });

  it('rejects a published row that has no external id unless it was a dry run', async () => {
    await insertEvent('le_x', 'published external id probe');
    await insertAtom('ca_x', 'le_x');
    await ctx.db.query(
      `INSERT INTO content_ideas (id, content_atom_id, learning_event_id, angle, title, rationale, audience, platforms, formats, hook, dedupe_hash, prompt_version)
       VALUES ('ci_x', 'ca_x', 'le_x', 'insight', 'T', 'R', 'A', ARRAY['x'], ARRAY['x_post'], 'H', $1, 'v1')`,
      [contentHash('x idea')],
    );
    await ctx.db.query(
      `INSERT INTO content_items (id, content_idea_id, content_atom_id, learning_event_id, platform, format, draft, prompt_id, prompt_version, model, correlation_id)
       VALUES ('it_x', 'ci_x', 'ca_x', 'le_x', 'x', 'x_post', '{}'::jsonb, 'x_post', 'v1', 'mock', 'cor')`,
    );
    await expect(
      ctx.db.query(
        `INSERT INTO publications (id, content_item_id, learning_event_id, platform, status, idempotency_key, provider, scheduled_at, dry_run, correlation_id)
         VALUES ('pb_x', 'it_x', 'le_x', 'x', 'published', $1, 'postiz', now(), false, 'cor')`,
        [idempotencyKey('it_x', 'x', 'slot')],
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('rejects a duplicate approval action id', async () => {
    await insertEvent('le_ap', 'approval action id probe');
    await insertAtom('ca_ap', 'le_ap');
    await ctx.db.query(
      `INSERT INTO content_ideas (id, content_atom_id, learning_event_id, angle, title, rationale, audience, platforms, formats, hook, dedupe_hash, prompt_version)
       VALUES ('ci_ap', 'ca_ap', 'le_ap', 'insight', 'T', 'R', 'A', ARRAY['x'], ARRAY['x_post'], 'H', $1, 'v1')`,
      [contentHash('ap idea')],
    );
    await ctx.db.query(
      `INSERT INTO content_items (id, content_idea_id, content_atom_id, learning_event_id, platform, format, draft, prompt_id, prompt_version, model, correlation_id)
       VALUES ('it_ap', 'ci_ap', 'ca_ap', 'le_ap', 'x', 'x_post', '{}'::jsonb, 'x_post', 'v1', 'mock', 'cor')`,
    );
    const approve = (id: string) =>
      ctx.db.query(
        `INSERT INTO approvals (id, content_item_id, content_item_version, action, action_id, decided_by, correlation_id)
         VALUES ($1, 'it_ap', 1, 'approve', 'act_stable_1', 'rohan', 'cor')`,
        [id],
      );
    await approve('ap_1');
    await expect(approve('ap_2')).rejects.toSatisfy(isUniqueViolation);
  });

  it('rejects a repeated webhook delivery', async () => {
    const deliver = (id: string) =>
      ctx.db.query(
        `INSERT INTO webhook_deliveries (id, provider, delivery_id, correlation_id)
         VALUES ($1, 'github', 'delivery-abc', 'cor')`,
        [id],
      );
    await deliver('wh_1');
    await expect(deliver('wh_2')).rejects.toSatisfy(isUniqueViolation);
  });

  it('allows only one outstanding job per dedupe key, but permits a later re-run', async () => {
    const enqueue = (id: string, status = 'pending') =>
      ctx.db.query(
        `INSERT INTO jobs (id, job_type, status, dedupe_key, correlation_id)
         VALUES ($1, 'collect_analytics', $2, 'pb_1:24h', 'cor')`,
        [id, status],
      );
    await enqueue('job_1');
    await expect(enqueue('job_2')).rejects.toSatisfy(isUniqueViolation);

    await ctx.db.query(`UPDATE jobs SET status = 'succeeded' WHERE id = 'job_1'`);
    await expect(enqueue('job_3')).resolves.toBeDefined();
  });

  it('rejects duplicate analytics for the same publication, window and day', async () => {
    await insertEvent('le_an', 'analytics dedupe probe note');
    await insertAtom('ca_an', 'le_an');
    await ctx.db.query(
      `INSERT INTO content_ideas (id, content_atom_id, learning_event_id, angle, title, rationale, audience, platforms, formats, hook, dedupe_hash, prompt_version)
       VALUES ('ci_an', 'ca_an', 'le_an', 'insight', 'T', 'R', 'A', ARRAY['x'], ARRAY['x_post'], 'H', $1, 'v1')`,
      [contentHash('an idea')],
    );
    await ctx.db.query(
      `INSERT INTO content_items (id, content_idea_id, content_atom_id, learning_event_id, platform, format, draft, prompt_id, prompt_version, model, correlation_id)
       VALUES ('it_an', 'ci_an', 'ca_an', 'le_an', 'x', 'x_post', '{}'::jsonb, 'x_post', 'v1', 'mock', 'cor')`,
    );
    await ctx.db.query(
      `INSERT INTO publications (id, content_item_id, learning_event_id, platform, idempotency_key, provider, scheduled_at, correlation_id)
       VALUES ('pb_an', 'it_an', 'le_an', 'x', $1, 'mock', now(), 'cor')`,
      [idempotencyKey('it_an', 'x', 'slot')],
    );
    const collect = (id: string) =>
      ctx.db.query(
        `INSERT INTO analytics_events (id, publication_id, content_item_id, learning_event_id, platform, metric_window, collected_for, provider, metrics)
         VALUES ($1, 'pb_an', 'it_an', 'le_an', 'x', '24h', '2026-09-22', 'mock', '{}'::jsonb)`,
        [id],
      );
    await collect('ae_1');
    await expect(collect('ae_2')).rejects.toSatisfy(isUniqueViolation);
  });
});
