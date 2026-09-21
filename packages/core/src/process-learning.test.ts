import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentAtoms,
  createTestDb,
  hasTestDatabase,
  learningEvents,
  operations,
  type TestDb,
} from '@sce/db';
import { createFailingLlmAdapter, createMockLlmAdapter, type LlmAdapter } from '@sce/adapters';
import {
  contentHash,
  createLogger,
  fixedClock,
  newCorrelationId,
  newId,
  parseEnv,
} from '@sce/utils';
import type { ServiceContext } from './context.js';
import { processLearningEvent, processPendingLearningEvents } from './process-learning.js';
import {
  DISTINCT_SAME_TOPIC,
  NEAR_DUPLICATE_PAIR,
  NOTE_FIXTURES,
} from '../../../tests/fixtures/learning-notes.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('learning processing pipeline', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const llm: LlmAdapter = createMockLlmAdapter();

  const capture = async (text: string) => {
    const { event } = await learningEvents.insertLearningEvent(db.db, {
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
    });
    return event;
  };

  beforeAll(async () => {
    db = await createTestDb('process_learning');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-21T12:00:00.000Z'),
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it('normalizes, classifies and creates exactly one atom shell', async () => {
    const event = await capture(NOTE_FIXTURES[0]!.text);
    const result = await processLearningEvent(ctx, event.id, { llm });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.event.status).toBe('atomized');
    expect(result.value.classification?.primary_topic).toBe('security');
    expect(result.value.atom?.status).toBe('draft');
    expect(result.value.atom_created).toBe(true);

    const stored = await learningEvents.findLearningEvent(db.db, event.id);
    expect(stored?.normalized_text).toBeTruthy();
    expect(stored?.raw_text).toBe(NOTE_FIXTURES[0]!.text); // raw text still untouched
    expect(stored?.title).toBeTruthy();
  });

  it('classifies each fixture into the declared taxonomy', async () => {
    for (const fixture of NOTE_FIXTURES) {
      const event = await capture(fixture.text);
      const result = await processLearningEvent(ctx, event.id, { llm });
      expect(result.ok, fixture.name).toBe(true);
      if (!result.ok) continue;

      const classification = result.value.classification!;
      if (fixture.expect.primaryTopics.length > 0) {
        expect(fixture.expect.primaryTopics, fixture.name).toContain(classification.primary_topic);
      }
      expect(classification.content_worthy, fixture.name).toBe(fixture.expect.contentWorthy);
      expect(classification.content_worthiness_reason.length, fixture.name).toBeGreaterThan(10);
      for (const entity of fixture.expect.entities ?? []) {
        expect(classification.entities, fixture.name).toContain(entity);
      }
    }
  });

  it('is idempotent: reprocessing changes nothing and creates no second atom', async () => {
    const event = await capture(NOTE_FIXTURES[1]!.text);
    const first = await processLearningEvent(ctx, event.id, { llm });
    const second = await processLearningEvent(ctx, event.id, { llm });
    const third = await processLearningEvent(ctx, event.id, { llm });

    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    expect(second.value.unchanged).toBe(true);
    expect(third.value.unchanged).toBe(true);
    expect(second.value.atom?.id).toBe(first.value.atom?.id);

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM content_atoms',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('forced reprocessing reuses the same atom rather than forking the event', async () => {
    const event = await capture(NOTE_FIXTURES[2]!.text);
    const first = await processLearningEvent(ctx, event.id, { llm });
    const forced = await processLearningEvent(ctx, event.id, { llm, force: true });

    expect(first.ok && forced.ok).toBe(true);
    if (!first.ok || !forced.ok) return;
    expect(forced.value.atom?.id).toBe(first.value.atom?.id);
    expect(forced.value.atom_created).toBe(false);

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM content_atoms',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('marks a restated note as a duplicate and keeps the reference, without a second atom', async () => {
    const original = await capture(NEAR_DUPLICATE_PAIR.original);
    await processLearningEvent(ctx, original.id, { llm });

    const restated = await capture(NEAR_DUPLICATE_PAIR.restated);
    const result = await processLearningEvent(ctx, restated.id, { llm });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event.status).toBe('duplicate');
    expect(result.value.duplicate_of).toBe(original.id);
    expect(result.value.atom).toBeNull();

    // Provenance preserved: the duplicate row still exists with its own raw text.
    const stored = await learningEvents.findLearningEvent(db.db, restated.id);
    expect(stored?.raw_text).toBe(NEAR_DUPLICATE_PAIR.restated);
    expect(stored?.duplicate_of).toBe(original.id);

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM content_atoms',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('does not treat a different learning about the same topic as a duplicate', async () => {
    const original = await capture(NEAR_DUPLICATE_PAIR.original);
    await processLearningEvent(ctx, original.id, { llm });

    const distinct = await capture(DISTINCT_SAME_TOPIC);
    const result = await processLearningEvent(ctx, distinct.id, { llm });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event.status).toBe('atomized');
    expect(result.value.duplicate_of).toBeNull();
  });

  it('records a failure instead of inventing a classification when the model is down', async () => {
    const event = await capture(NOTE_FIXTURES[3]!.text);
    const result = await processLearningEvent(ctx, event.id, { llm: createFailingLlmAdapter() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('transient');

    const stored = await learningEvents.findLearningEvent(db.db, event.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.classification).toBeNull();

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ workflow: 'learning_process_v1', step: 'classify' });

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM content_atoms',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('recovers when the model comes back, using force', async () => {
    const event = await capture(NOTE_FIXTURES[5]!.text);
    await processLearningEvent(ctx, event.id, { llm: createFailingLlmAdapter() });

    const recovered = await processLearningEvent(ctx, event.id, { llm, force: true });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.atom).not.toBeNull();
  });

  it('rejects a malformed model answer rather than storing it', async () => {
    const liar = createMockLlmAdapter({
      handlers: { 'classify.v1': () => ({ kind: 'nonsense', primary_topic: 'quantum' }) },
    });
    const event = await capture(NOTE_FIXTURES[0]!.text);
    const result = await processLearningEvent(ctx, event.id, { llm: liar });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_LLM_SCHEMA');
    expect(result.error.kind).toBe('permanent');

    const stored = await learningEvents.findLearningEvent(db.db, event.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.classification).toBeNull();
  });

  it('records a workflow run for every processing attempt', async () => {
    const event = await capture(NOTE_FIXTURES[1]!.text);
    await processLearningEvent(ctx, event.id, { llm });

    const runs = await operations.listWorkflowRuns(db.db, { workflow: 'learning_process_v1' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', subject_id: event.id });
  });

  it('returns 404-style failure for an unknown event', async () => {
    const result = await processLearningEvent(ctx, 'le_missing', { llm });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_EVENT_NOT_FOUND');
  });

  it('processes a batch of pending events and reports failures without stopping', async () => {
    await capture(NOTE_FIXTURES[0]!.text);
    await capture(NOTE_FIXTURES[3]!.text);

    const results = await processPendingLearningEvents(ctx, { llm });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);

    // Nothing is left pending, so a second sweep is a no-op.
    const second = await processPendingLearningEvents(ctx, { llm });
    expect(second).toHaveLength(0);
  });

  it('keeps one canonical atom per event even under concurrent processing', async () => {
    const event = await capture(NOTE_FIXTURES[2]!.text);
    const results = await Promise.all([
      processLearningEvent(ctx, event.id, { llm }),
      processLearningEvent(ctx, event.id, { llm }),
      processLearningEvent(ctx, event.id, { llm }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const atomIds = new Set(
      results.filter((r) => r.ok).map((r) => (r.ok ? r.value.atom?.id : null)),
    );
    expect(atomIds.size).toBe(1);

    const stored = await contentAtoms.findAtomByLearningEvent(db.db, event.id);
    expect(stored).not.toBeNull();
    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM content_atoms',
    );
    expect(rows[0]!.count).toBe(1);
  });
});
