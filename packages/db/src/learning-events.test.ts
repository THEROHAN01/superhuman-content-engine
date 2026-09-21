import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, newCorrelationId, newId } from '@sce/utils';
import { createTestDb, hasTestDatabase, type TestDb } from './testing.js';
import {
  advanceStatus,
  findLearningEvent,
  insertLearningEvent,
  listLearningEvents,
} from './repositories/learning-events.js';
import { removeSeedData, seed } from './seed.js';
import { recordWebhookDelivery } from './repositories/operations.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('learning event repository', () => {
  let ctx: TestDb;

  const capture = (
    text: string,
    overrides: Partial<Parameters<typeof insertLearningEvent>[1]> = {},
  ) =>
    insertLearningEvent(ctx.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: null,
      content_hash: contentHash(text),
      tags: [],
      context: {},
      captured_at: new Date().toISOString(),
      correlation_id: newCorrelationId(),
      ...overrides,
    });

  beforeAll(async () => {
    ctx = await createTestDb('learning_events_repo');
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
  });

  it('stores the raw text unchanged', async () => {
    const raw = '  Today I learned **why** refresh-token rotation matters.  ';
    const { event } = await capture(raw);
    expect(event.raw_text).toBe(raw);
  });

  it('is idempotent: capturing the same note twice yields one row and the original id', async () => {
    const text = 'redis keyspace notifications are best-effort, not a durable event log';
    const first = await capture(text);
    const second = await capture(text);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.id).toBe(first.event.id);

    const { rows } = await ctx.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('deduplicates concurrent captures of the same note', async () => {
    const text = 'concurrent capture of one idea must produce exactly one learning event';
    const results = await Promise.all([capture(text), capture(text), capture(text)]);
    const ids = new Set(results.map((r) => r.event.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
  });

  it('advances status forward but never backwards', async () => {
    const { event } = await capture('status machine probe: partial indexes in postgres');

    const normalized = await advanceStatus(ctx.db, event.id, 'normalized', {
      normalized_text: 'status machine probe',
    });
    expect(normalized).toMatchObject({ changed: true });
    expect(normalized!.event.status).toBe('normalized');

    const classified = await advanceStatus(ctx.db, event.id, 'classified');
    expect(classified!.event.status).toBe('classified');

    // A replayed normalization must not pull the event back.
    const replay = await advanceStatus(ctx.db, event.id, 'normalized');
    expect(replay).toMatchObject({ changed: false });
    expect(replay!.event.status).toBe('classified');
  });

  it('returns null when advancing an unknown event', async () => {
    expect(await advanceStatus(ctx.db, 'le_missing', 'normalized')).toBeNull();
  });

  it('lists events filtered by status, newest first', async () => {
    await capture('first note about database indexes and their cost');
    const second = await capture('second note about connection pooling limits');
    await advanceStatus(ctx.db, second.event.id, 'normalized');

    const normalized = await listLearningEvents(ctx.db, { status: 'normalized' });
    expect(normalized.map((e) => e.id)).toEqual([second.event.id]);
    expect(await listLearningEvents(ctx.db)).toHaveLength(2);
  });

  it('round-trips through the zod schema', async () => {
    const { event } = await capture('schema round trip probe for learning events');
    const found = await findLearningEvent(ctx.db, event.id);
    expect(found).toEqual(event);
  });
});

describeDb('seed data', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await createTestDb('seed');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('seeds idempotently and removes exactly what it created', async () => {
    const first = await seed(ctx.db);
    expect(first.created.length).toBeGreaterThan(0);

    const second = await seed(ctx.db);
    expect(second.created).toHaveLength(0);
    expect(second.existing).toHaveLength(first.created.length);

    const removed = await removeSeedData(ctx.db);
    expect(removed).toBe(first.created.length);

    const { rows } = await ctx.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(0);
  });
});

describeDb('webhook delivery deduplication', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await createTestDb('webhooks');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('recognises a redelivered webhook instead of processing it again', async () => {
    const first = await recordWebhookDelivery(ctx.db, {
      provider: 'github',
      deliveryId: 'abc-123',
      eventType: 'pull_request',
      correlationId: newCorrelationId(),
    });
    const replay = await recordWebhookDelivery(ctx.db, {
      provider: 'github',
      deliveryId: 'abc-123',
      eventType: 'pull_request',
      correlationId: newCorrelationId(),
    });
    expect(first.isNew).toBe(true);
    expect(replay.isNew).toBe(false);
    expect(replay.id).toBe(first.id);
  });
});
