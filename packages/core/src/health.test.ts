import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentAtoms,
  contentIdeas,
  contentItems,
  createTestDb,
  hasTestDatabase,
  jobs as jobsRepo,
  learningEvents,
  operations,
  publications as publicationsRepo,
  type TestDb,
} from '@sce/db';
import {
  contentHash,
  createLogger,
  fixedClock,
  idempotencyKey,
  newCorrelationId,
  newId,
  parseEnv,
} from '@sce/utils';
import type { ServiceContext } from './context.js';
import { checkSystemHealth, dueScheduledPublications, sweepStuckWork } from './health.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;
const NOW = '2026-09-24T12:00:00.000Z';

describeDb('system health', () => {
  let db: TestDb;
  let ctx: ServiceContext;

  /** Builds a content item and, optionally, a publication in a chosen state. */
  const chain = async (options: {
    itemStatus?: 'draft' | 'gated' | 'pending_approval' | 'approved';
    publication?: {
      status: 'retry_pending' | 'scheduled';
      attempts?: number;
      scheduledAt?: string;
    };
    ageHours?: number;
  }) => {
    const text = `note ${newId('learningEvent')} for health checks`;
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: 'Health',
      content_hash: contentHash(text),
      tags: [],
      context: {},
      captured_at: NOW,
      correlation_id: newCorrelationId(),
    });
    const { atom } = await contentAtoms.upsertContentAtom(db.db, {
      id: newId('contentAtom'),
      learning_event_id: event.id,
      status: 'ready',
      title: 'Health probe',
      kind: 'core_engineering',
      primary_topic: 'observability',
      secondary_topics: [],
      entities: [],
      body: {
        problem: 'Is anything stuck right now?',
        core_insight: 'Green dependencies say nothing about whether work is moving.',
        first_principles: 'Liveness is about the process; progress is about the queue.',
        example: null,
        implementation_details: null,
        failure_mode: null,
        mental_model: null,
        personal_observation: null,
        claims: [],
        angle_candidates: ['insight'],
      },
      evidence_status: 'not_required',
      confidence: 0.7,
      generator_version: 'atom.v1',
    });
    const { idea } = await contentIdeas.insertContentIdea(db.db, {
      id: newId('contentIdea'),
      content_atom_id: atom.id,
      learning_event_id: event.id,
      status: 'used',
      angle: 'insight',
      title: 'Health probe idea',
      rationale: 'Distinguishes liveness from progress.',
      audience: 'engineers',
      platforms: ['x'],
      formats: ['x_post'],
      hook: 'Green dependencies are not progress.',
      evidence_required: false,
      dedupe_hash: contentHash(newId('contentIdea')),
      rejection_reason: null,
      score: 0.6,
      prompt_version: 'ideation.v1',
    });
    const body =
      'Green dependencies say nothing about whether work is moving, because liveness and progress are different questions.';
    const { item } = await contentItems.insertContentItemVersion(db.db, {
      id: newId('contentItem'),
      content_idea_id: idea.id,
      content_atom_id: atom.id,
      learning_event_id: event.id,
      platform: 'x',
      format: 'x_post',
      draft: {
        hook: 'Green dependencies are not progress.',
        units: [{ index: 0, text: body, note: null }],
        body,
        hashtags: [],
        call_to_action: null,
        source_attributions: [],
      },
      prompt_id: 'x_post',
      prompt_version: 'x-post.v1',
      model: 'mock',
      correlation_id: event.correlation_id,
    });

    for (const status of ['gated', 'pending_approval', 'approved'] as const) {
      if (options.itemStatus === 'draft') break;
      await contentItems.setContentItemStatus(db.db, item.id, status);
      if (options.itemStatus === status) break;
    }

    if (options.ageHours) {
      // `set_updated_at` fires on every UPDATE, so `updated_at` cannot be backdated through a
      // normal statement - the trigger has to be stepped around deliberately to simulate age.
      await db.db.query(`ALTER TABLE content_items DISABLE TRIGGER content_items_set_updated_at`);
      await db.db.query(
        `UPDATE content_items SET created_at = now() - make_interval(hours => $2::int),
                                  updated_at = now() - make_interval(hours => $2::int)
         WHERE id = $1`,
        [item.id, options.ageHours],
      );
      await db.db.query(`ALTER TABLE content_items ENABLE TRIGGER content_items_set_updated_at`);
    }

    if (!options.publication) return { item, publication: null };

    const scheduledAt = options.publication.scheduledAt ?? NOW;
    const { publication } = await publicationsRepo.claimPublication(db.db, {
      id: newId('publication'),
      content_item_id: item.id,
      learning_event_id: event.id,
      platform: 'x',
      idempotency_key: idempotencyKey(item.id, 'x', scheduledAt),
      provider: 'mock',
      scheduled_at: scheduledAt,
      dry_run: true,
      correlation_id: event.correlation_id,
    });

    if (options.publication.status === 'scheduled') {
      await publicationsRepo.setPublicationStatus(db.db, publication.id, 'scheduled', {
        external_id: `ext-${publication.id}`,
      });
    } else {
      await publicationsRepo.setPublicationStatus(db.db, publication.id, 'retry_pending', {
        last_error: 'provider timed out',
      });
      await db.db.query(`ALTER TABLE publications DISABLE TRIGGER publications_set_updated_at`);
      await db.db.query(
        `UPDATE publications SET attempts = $2, updated_at = now() - interval '12 hours' WHERE id = $1`,
        [publication.id, options.publication.attempts ?? 1],
      );
      await db.db.query(`ALTER TABLE publications ENABLE TRIGGER publications_set_updated_at`);
    }

    return { item, publication };
  };

  beforeAll(async () => {
    db = await createTestDb('health');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
        WORKER_MAX_ATTEMPTS: '3',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock(NOW),
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it('reports healthy when dependencies work and nothing is stuck', async () => {
    const health = await checkSystemHealth(ctx);
    expect(health.status).toBe('healthy');
    expect(health.checks['database']?.ok).toBe(true);
    expect(health.checks['migrations']?.ok).toBe(true);
    expect(health.stalled).toEqual([]);
    expect(health.config['publish_mode']).toBe('dry_run');
  });

  it('is degraded - not unhealthy - when dependencies are fine but work is stuck', async () => {
    await chain({ itemStatus: 'pending_approval', ageHours: 100 });

    const health = await checkSystemHealth(ctx);
    expect(health.status).toBe('degraded');
    expect(health.checks['database']?.ok).toBe(true);
    const stall = health.stalled.find((s) => s.kind === 'awaiting_approval')!;
    expect(stall.count).toBe(1);
    expect(stall.oldest_hours).toBeGreaterThan(72);
  });

  it('notices captures that were never processed', async () => {
    const text = 'a note that nothing ever picked up for classification or atom building';
    await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: null,
      content_hash: contentHash(text),
      tags: [],
      context: {},
      captured_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
      correlation_id: newCorrelationId(),
    });

    const health = await checkSystemHealth(ctx);
    expect(health.stalled.some((s) => s.kind === 'learning_unprocessed')).toBe(true);
  });

  it('notices drafts that never reached the quality gate', async () => {
    await chain({ itemStatus: 'draft', ageHours: 24 });
    const health = await checkSystemHealth(ctx);
    expect(health.stalled.some((s) => s.kind === 'draft_ungated')).toBe(true);
  });

  it('notices publications retrying and slots that passed unconfirmed', async () => {
    await chain({ itemStatus: 'approved', publication: { status: 'retry_pending' } });
    // Relative to the database clock, not the test's fixed clock: the stall queries use now().
    const pastSlot = new Date(Date.now() - 6 * 3600_000).toISOString();
    await chain({
      itemStatus: 'approved',
      publication: { status: 'scheduled', scheduledAt: pastSlot },
    });

    const health = await checkSystemHealth(ctx);
    expect(health.stalled.map((s) => s.kind).sort()).toEqual(
      expect.arrayContaining(['publication_overdue', 'publication_retrying']),
    );
  });

  it('notices dead jobs', async () => {
    await jobsRepo.enqueueJob(db.db, {
      id: newId('job'),
      job_type: 'probe',
      dedupe_key: 'dead-probe',
      correlation_id: 'cor_test',
    });
    await db.db.query(`UPDATE jobs SET status = 'dead', last_error = 'gave up'`);

    const health = await checkSystemHealth(ctx);
    expect(health.stalled.find((s) => s.kind === 'job_dead')?.count).toBe(1);
  });

  it('summarizes recent errors by code', async () => {
    for (let i = 0; i < 3; i++) {
      await operations.recordError(db.db, {
        workflow: 'content_publish_v1',
        kind: 'transient',
        code: 'E_PUBLISH_HTTP',
        message: 'provider returned 503',
        correlationId: 'cor_test',
      });
    }

    const health = await checkSystemHealth(ctx);
    expect(health.recent_errors[0]).toMatchObject({ code: 'E_PUBLISH_HTTP', count: 3 });
  });
});

describeDb('recovery sweep', () => {
  let db: TestDb;
  let ctx: ServiceContext;

  beforeAll(async () => {
    db = await createTestDb('health_sweep');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
        WORKER_MAX_ATTEMPTS: '3',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock(NOW),
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  const publicationWith = async (attempts: number) => {
    const text = `note ${newId('learningEvent')} sweep probe`;
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: null,
      content_hash: contentHash(text),
      tags: [],
      context: {},
      captured_at: NOW,
      correlation_id: newCorrelationId(),
    });
    const { atom } = await contentAtoms.upsertContentAtom(db.db, {
      id: newId('contentAtom'),
      learning_event_id: event.id,
      status: 'ready',
      title: 'Sweep probe',
      kind: 'core_engineering',
      primary_topic: 'backend',
      secondary_topics: [],
      entities: [],
      body: {
        problem: 'What happens to work nobody finished?',
        core_insight: 'It must become visible rather than disappear.',
        first_principles: 'A retry budget without a terminal state retries forever.',
        example: null,
        implementation_details: null,
        failure_mode: null,
        mental_model: null,
        personal_observation: null,
        claims: [],
        angle_candidates: ['insight'],
      },
      evidence_status: 'not_required',
      confidence: 0.6,
      generator_version: 'atom.v1',
    });
    const { idea } = await contentIdeas.insertContentIdea(db.db, {
      id: newId('contentIdea'),
      content_atom_id: atom.id,
      learning_event_id: event.id,
      status: 'used',
      angle: 'insight',
      title: 'Sweep probe idea',
      rationale: 'Explains terminal states.',
      audience: 'engineers',
      platforms: ['x'],
      formats: ['x_post'],
      hook: 'A retry budget needs a terminal state.',
      evidence_required: false,
      dedupe_hash: contentHash(newId('contentIdea')),
      rejection_reason: null,
      score: 0.6,
      prompt_version: 'ideation.v1',
    });
    const body =
      'A retry budget without a terminal state retries forever, so exhausted work must become visible instead of disappearing.';
    const { item } = await contentItems.insertContentItemVersion(db.db, {
      id: newId('contentItem'),
      content_idea_id: idea.id,
      content_atom_id: atom.id,
      learning_event_id: event.id,
      platform: 'x',
      format: 'x_post',
      draft: {
        hook: 'A retry budget needs a terminal state.',
        units: [{ index: 0, text: body, note: null }],
        body,
        hashtags: [],
        call_to_action: null,
        source_attributions: [],
      },
      prompt_id: 'x_post',
      prompt_version: 'x-post.v1',
      model: 'mock',
      correlation_id: event.correlation_id,
    });
    const { publication } = await publicationsRepo.claimPublication(db.db, {
      id: newId('publication'),
      content_item_id: item.id,
      learning_event_id: event.id,
      platform: 'x',
      idempotency_key: idempotencyKey(item.id, 'x', NOW),
      provider: 'mock',
      scheduled_at: NOW,
      dry_run: true,
      correlation_id: event.correlation_id,
    });
    await publicationsRepo.setPublicationStatus(db.db, publication.id, 'retry_pending', {
      last_error: 'provider timed out',
    });
    await db.db.query(`UPDATE publications SET attempts = $2 WHERE id = $1`, [
      publication.id,
      attempts,
    ]);
    return publication;
  };

  it('requeues a publication that still has attempts left', async () => {
    const publication = await publicationWith(1);
    const result = await sweepStuckWork(ctx);

    expect(result.requeued_publications).toBe(1);
    expect(result.dead_letters).toBe(0);

    const stored = await publicationsRepo.findPublication(db.db, publication.id);
    expect(stored?.status).toBe('pending');
  });

  it('dead-letters a publication that exhausted its budget, and records why', async () => {
    const publication = await publicationWith(3);
    const result = await sweepStuckWork(ctx);

    expect(result.dead_letters).toBe(1);
    const stored = await publicationsRepo.findPublication(db.db, publication.id);
    expect(stored?.status).toBe('failed');

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors[0]).toMatchObject({ code: 'E_PUBLISH_EXHAUSTED', workflow: 'system_sweep_v1' });
    expect(errors[0]!.message).toContain('gave up after 3 attempts');
  });

  it('releases jobs abandoned by a crashed worker', async () => {
    await jobsRepo.enqueueJob(db.db, {
      id: newId('job'),
      job_type: 'probe',
      dedupe_key: 'abandoned-job',
      correlation_id: 'cor_test',
    });
    await db.db.query(
      `UPDATE jobs SET status = 'running', locked_at = now() - interval '2 hours', locked_by = 'gone'`,
    );

    const result = await sweepStuckWork(ctx);
    expect(result.released_jobs).toBe(1);

    const stored = await jobsRepo.listJobs(db.db, {});
    expect(stored[0]!.status).toBe('pending');
  });

  it('is safe to run repeatedly', async () => {
    await publicationWith(3);
    const first = await sweepStuckWork(ctx);
    const second = await sweepStuckWork(ctx);
    const third = await sweepStuckWork(ctx);

    expect(first.dead_letters).toBe(1);
    expect(second).toEqual({ released_jobs: 0, requeued_publications: 0, dead_letters: 0 });
    expect(third).toEqual({ released_jobs: 0, requeued_publications: 0, dead_letters: 0 });

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors.filter((e) => e.code === 'E_PUBLISH_EXHAUSTED')).toHaveLength(1);
  });

  it('lists publications whose slot has passed', async () => {
    const publication = await publicationWith(1);
    await publicationsRepo.setPublicationStatus(db.db, publication.id, 'scheduled', {
      external_id: 'ext-1',
    });
    await db.db.query(
      `UPDATE publications SET scheduled_at = now() - interval '1 hour' WHERE id = $1`,
      [publication.id],
    );

    const due = await dueScheduledPublications(ctx);
    expect(due.map((p) => p.id)).toContain(publication.id);
  });
});
