import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentAtoms,
  contentIdeas,
  contentItems,
  createTestDb,
  hasTestDatabase,
  learningEvents,
  operations,
  publications as publicationsRepo,
  type TestDb,
} from '@sce/db';
import {
  createFailingPublishingAdapter,
  createMockPublishingAdapter,
  type MockPublishingAdapter,
  type PublishingAdapter,
} from '@sce/adapters';
import {
  contentHash,
  createLogger,
  fixedClock,
  newCorrelationId,
  newId,
  parseEnv,
  permanent,
} from '@sce/utils';
import type { ContentItem } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import {
  cancelPublication,
  markPublished,
  publicationIdempotencyKey,
  schedulePublication,
} from './publish.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;
const SLOT = '2026-09-22T09:00:00.000Z';

/** Wraps a publisher to count the calls that actually reached it. */
const countingPublisher = (
  inner: PublishingAdapter,
): { adapter: PublishingAdapter; calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      ...inner,
      async schedule(payload) {
        calls++;
        return inner.schedule(payload);
      },
    },
  };
};

describeDb('publishing', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  let publisher: MockPublishingAdapter;

  const makeContext = (overrides: Record<string, string> = {}): ServiceContext => ({
    db: db.db,
    env: parseEnv({
      DATABASE_URL: process.env['TEST_DATABASE_URL']!,
      NODE_ENV: 'test',
      ...overrides,
    } as NodeJS.ProcessEnv),
    logger: createLogger({ name: 'test', level: 'silent' }),
    clock: fixedClock('2026-09-21T12:00:00.000Z'),
  });

  const approvedItem = async (): Promise<ContentItem> => {
    const text = `note ${newId('learningEvent')} about publishing idempotency`;
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: 'Publishing',
      content_hash: contentHash(text),
      tags: [],
      context: {},
      captured_at: new Date().toISOString(),
      correlation_id: newCorrelationId(),
    });
    const { atom } = await contentAtoms.upsertContentAtom(db.db, {
      id: newId('contentAtom'),
      learning_event_id: event.id,
      status: 'ready',
      title: 'Publishing idempotency',
      kind: 'core_engineering',
      primary_topic: 'distributed_systems',
      secondary_topics: [],
      entities: [],
      body: {
        problem: 'How do we avoid double publishing?',
        core_insight: 'Claim the slot in the database before calling the provider.',
        first_principles: 'A unique key resolves the race that a check-then-send cannot.',
        example: null,
        implementation_details: null,
        failure_mode: null,
        mental_model: null,
        personal_observation: null,
        claims: [],
        angle_candidates: ['insight'],
      },
      evidence_status: 'not_required',
      confidence: 0.8,
      generator_version: 'atom.v1',
    });
    const { idea } = await contentIdeas.insertContentIdea(db.db, {
      id: newId('contentIdea'),
      content_atom_id: atom.id,
      learning_event_id: event.id,
      status: 'used',
      angle: 'insight',
      title: 'Claim the slot first',
      rationale: 'Explains the ordering that makes retries safe.',
      audience: 'backend engineers',
      platforms: ['x'],
      formats: ['x_post'],
      hook: 'Claim the slot before you call the provider.',
      evidence_required: false,
      dedupe_hash: contentHash(newId('contentIdea')),
      rejection_reason: null,
      score: 0.8,
      prompt_version: 'ideation.v1',
    });
    const body =
      'Claim the slot in your own database before calling the provider, because a retry after a timeout cannot otherwise tell "sent" from "never sent".';
    const { item } = await contentItems.insertContentItemVersion(db.db, {
      id: newId('contentItem'),
      content_idea_id: idea.id,
      content_atom_id: atom.id,
      learning_event_id: event.id,
      platform: 'x',
      format: 'x_post',
      draft: {
        hook: 'Claim the slot before you call the provider.',
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

    // Walk the real status path: gated -> pending_approval -> approved.
    await contentItems.setContentItemStatus(db.db, item.id, 'gated');
    await contentItems.setContentItemStatus(db.db, item.id, 'pending_approval');
    const approved = await contentItems.setContentItemStatus(db.db, item.id, 'approved');
    return approved!.item;
  };

  beforeAll(async () => {
    db = await createTestDb('publishing');
    ctx = makeContext();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
    publisher = createMockPublishingAdapter();
  });

  it('schedules approved content and stores the provider id', async () => {
    const item = await approvedItem();
    const result = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.publication.status).toBe('scheduled');
    expect(result.value.publication.external_id).toBe('mock-post-1');
    expect(result.value.publication.external_url).toContain('mock.invalid');
    expect(result.value.publication.attempts).toBe(1);

    const stored = await contentItems.findContentItem(db.db, item.id);
    expect(stored?.status).toBe('scheduled');
  });

  it('refuses to publish content that was never approved', async () => {
    const item = await approvedItem();
    // Walk it back to where it was before a human decided: gated, awaiting approval.
    await db.db.query(`UPDATE content_items SET status = 'gated' WHERE id = $1`, [item.id]);

    const result = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_NOT_APPROVED');
    expect(publisher.posts.size).toBe(0);
  });

  it('refuses to publish content whose approval was withdrawn', async () => {
    const item = await approvedItem();
    const withdrawn = await contentItems.setContentItemStatus(db.db, item.id, 'rejected');
    expect(withdrawn?.changed).toBe(true);

    const result = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_NOT_APPROVED');
    expect(publisher.posts.size).toBe(0);
  });

  it('is idempotent: re-running does not create a second publication or a second post', async () => {
    const item = await approvedItem();
    const first = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    const second = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    const third = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });

    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;
    expect(first.value.created).toBe(true);
    expect(second.value.created).toBe(false);
    expect(third.value.created).toBe(false);
    expect(second.value.publication.id).toBe(first.value.publication.id);

    expect(publisher.posts.size).toBe(1);
    const rows = await publicationsRepo.listPublicationsForItem(db.db, item.id);
    expect(rows).toHaveLength(1);
  });

  it('concurrent publish requests produce exactly one post', async () => {
    const item = await approvedItem();
    const results = await Promise.all([
      schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT }),
      schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT }),
      schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.value.created)).toHaveLength(1);
    expect(publisher.posts.size).toBe(1);

    const { rows } = await db.db.query<{ count: number }>('SELECT count(*)::int FROM publications');
    expect(rows[0]!.count).toBe(1);
  });

  it('treats a different slot as a different publication', async () => {
    const item = await approvedItem();
    await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    const later = await schedulePublication(ctx, item.id, {
      publisher,
      scheduledAt: '2026-09-23T09:00:00.000Z',
    });

    expect(later.ok && later.value.created).toBe(true);
    expect(publisher.posts.size).toBe(2);
  });

  it('defaults to a dry run and records it as such', async () => {
    const item = await approvedItem();
    const result = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dry_run).toBe(true);
    expect(result.value.publication.dry_run).toBe(true);
  });

  it('still dry-runs in live mode when the provider cannot reach a platform', async () => {
    const liveCtx = makeContext({
      PUBLISH_MODE: 'live',
      PUBLISHING_PROVIDER: 'postiz',
      POSTIZ_BASE_URL: 'https://postiz.test',
      POSTIZ_API_KEY: 'k',
    });
    const item = await approvedItem();

    // The configuration says live, but the injected provider is the simulated one.
    const result = await schedulePublication(liveCtx, item.id, { publisher, scheduledAt: SLOT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dry_run).toBe(true);
  });

  it('keeps a transient provider failure retryable', async () => {
    const item = await approvedItem();
    const result = await schedulePublication(ctx, item.id, {
      publisher: createFailingPublishingAdapter(),
      scheduledAt: SLOT,
      attempts: 2,
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    const rows = await publicationsRepo.listPublicationsForItem(db.db, item.id);
    expect(rows[0]).toMatchObject({ status: 'retry_pending', attempts: 1 });
    expect(rows[0]!.last_error).toContain('E_PUBLISH_UNREACHABLE');

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors.some((e) => e.workflow === 'content_publish_v1')).toBe(true);
  });

  it('marks a permanent provider failure as failed, not retryable', async () => {
    const rejecting: PublishingAdapter = {
      name: 'rejecting',
      simulated: true,
      async schedule() {
        return { ok: false, error: permanent('E_PUBLISH_HTTP', 'postiz returned 400') };
      },
      async cancel() {
        return { ok: true, value: undefined };
      },
    };

    const item = await approvedItem();
    await schedulePublication(ctx, item.id, {
      publisher: rejecting,
      scheduledAt: SLOT,
      sleep: async () => {},
    });

    const rows = await publicationsRepo.listPublicationsForItem(db.db, item.id);
    expect(rows[0]!.status).toBe('failed');
  });

  it('recovers after a transient failure without creating a second post', async () => {
    const item = await approvedItem();
    await schedulePublication(ctx, item.id, {
      publisher: createFailingPublishingAdapter(),
      scheduledAt: SLOT,
      attempts: 1,
      sleep: async () => {},
    });

    // Same slot, working provider: the claimed row is reused *and* actually reaches the provider
    // this time. Returning the stranded row without retrying would leave the publication stuck
    // forever, because nothing else ever calls the provider for it.
    const retry = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.created).toBe(false);
    expect(retry.value.publication.status).toBe('scheduled');
    expect(retry.value.publication.external_id).toBeTruthy();

    const rows = await publicationsRepo.listPublicationsForItem(db.db, item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('scheduled');
  });

  it('records the provider that actually produced the external id, not the one that failed', async () => {
    const item = await approvedItem();
    await schedulePublication(ctx, item.id, {
      publisher: createFailingPublishingAdapter(),
      scheduledAt: SLOT,
      attempts: 1,
      sleep: async () => {},
    });

    const stranded = await publicationsRepo.listPublicationsForItem(db.db, item.id);
    expect(stranded[0]).toMatchObject({ status: 'retry_pending', provider: 'failing' });

    // The retry is served by a different provider than the one the row was claimed under.
    // `(provider, external_id)` is unique, so attributing this id to `failing` would both record a
    // falsehood and enforce uniqueness against the wrong pair.
    const retry = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;

    const rows = await publicationsRepo.listPublicationsForItem(db.db, item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'scheduled',
      provider: publisher.name,
      external_id: retry.value.publication.external_id,
    });
  });

  it('does not call the provider again once a slot has been published', async () => {
    const item = await approvedItem();
    const counted = countingPublisher(publisher);

    const first = await schedulePublication(ctx, item.id, {
      publisher: counted.adapter,
      scheduledAt: SLOT,
    });
    expect(first.ok).toBe(true);
    expect(counted.calls()).toBe(1);

    const again = await schedulePublication(ctx, item.id, {
      publisher: counted.adapter,
      scheduledAt: SLOT,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.created).toBe(false);
    // The provider was not touched: the existing external id stands.
    expect(counted.calls()).toBe(1);
  });

  it('stops retrying a slot that has exhausted its attempt budget', async () => {
    const item = await approvedItem();
    const failing = createFailingPublishingAdapter();

    for (let i = 0; i < ctx.env.WORKER_MAX_ATTEMPTS; i++) {
      await schedulePublication(ctx, item.id, {
        publisher: failing,
        scheduledAt: SLOT,
        attempts: 1,
        sleep: async () => {},
      });
    }

    const counted = countingPublisher(publisher);
    const exhausted = await schedulePublication(ctx, item.id, {
      publisher: counted.adapter,
      scheduledAt: SLOT,
    });

    // The budget is spent: the sweep dead-letters this row rather than the API retrying forever.
    expect(exhausted.ok).toBe(true);
    if (!exhausted.ok) return;
    expect(exhausted.value.created).toBe(false);
    expect(counted.calls()).toBe(0);
    expect(exhausted.value.publication.attempts).toBeGreaterThanOrEqual(
      ctx.env.WORKER_MAX_ATTEMPTS,
    );
  });

  it('cancels a scheduled publication', async () => {
    const item = await approvedItem();
    const scheduled = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) return;

    const cancelled = await cancelPublication(ctx, scheduled.value.publication.id, { publisher });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.publication.status).toBe('cancelled');

    const again = await cancelPublication(ctx, scheduled.value.publication.id, { publisher });
    expect(again.ok && again.value.cancelled).toBe(false); // idempotent
  });

  it('refuses to cancel something already published', async () => {
    const item = await approvedItem();
    const scheduled = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    if (!scheduled.ok) return;
    await markPublished(ctx, scheduled.value.publication.id);

    const cancelled = await cancelPublication(ctx, scheduled.value.publication.id, { publisher });
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.error.code).toBe('E_ALREADY_PUBLISHED');
  });

  it('marking published is idempotent and moves the item to published', async () => {
    const item = await approvedItem();
    const scheduled = await schedulePublication(ctx, item.id, { publisher, scheduledAt: SLOT });
    if (!scheduled.ok) return;

    const first = await markPublished(ctx, scheduled.value.publication.id);
    const second = await markPublished(ctx, scheduled.value.publication.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.published_at).toBe(first.value.published_at);

    const stored = await contentItems.findContentItem(db.db, item.id);
    expect(stored?.status).toBe('published');
  });

  it('derives the same idempotency key from equivalent timestamps', () => {
    expect(publicationIdempotencyKey('it_a', 'x', '2026-09-22T09:00:00Z')).toBe(
      publicationIdempotencyKey('it_a', 'x', '2026-09-22T09:00:00.000Z'),
    );
    expect(publicationIdempotencyKey('it_a', 'x', SLOT)).not.toBe(
      publicationIdempotencyKey('it_b', 'x', SLOT),
    );
  });

  it('rejects an invalid schedule time', async () => {
    const item = await approvedItem();
    const result = await schedulePublication(ctx, item.id, {
      publisher,
      scheduledAt: 'not-a-time',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_INVALID_SCHEDULE');
  });
});

describeDb('provider returning a duplicate external id', () => {
  let db: TestDb;
  let ctx: ServiceContext;

  beforeAll(async () => {
    db = await createTestDb('publishing_duplicate_id');
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

  it('fails the publication with a clear reason instead of a raw database error', async () => {
    // A provider that hands back the same id for every post: two of our publications would claim
    // one real post, which must be refused loudly.
    const confused: PublishingAdapter = {
      name: 'confused',
      simulated: true,
      async schedule() {
        return {
          ok: true,
          value: {
            externalId: 'same-id-every-time',
            externalUrl: null,
            status: 'scheduled',
            metadata: {},
          },
        };
      },
      async cancel() {
        return { ok: true, value: undefined };
      },
    };

    await db.truncate();

    const makeApproved = async () => {
      const text = `note ${newId('learningEvent')} duplicate external id probe`;
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
      const { atom } = await contentAtoms.upsertContentAtom(db.db, {
        id: newId('contentAtom'),
        learning_event_id: event.id,
        status: 'ready',
        title: 'Duplicate provider ids',
        kind: 'core_engineering',
        primary_topic: 'backend',
        secondary_topics: [],
        entities: [],
        body: {
          problem: 'Why would a provider hand back the same id twice?',
          core_insight: 'Two publications claiming one post is a contradiction, not a retry.',
          first_principles:
            'Provider ids are the only handle on a post, so they must map one to one.',
          example: null,
          implementation_details: null,
          failure_mode: null,
          mental_model: null,
          personal_observation: null,
          claims: [],
          angle_candidates: [],
        },
        evidence_status: 'not_required',
        confidence: 0.5,
        generator_version: 'atom.v1',
      });
      const { idea } = await contentIdeas.insertContentIdea(db.db, {
        id: newId('contentIdea'),
        content_atom_id: atom.id,
        learning_event_id: event.id,
        status: 'used',
        angle: 'insight',
        title: 'Duplicate provider ids are a contradiction',
        rationale: 'Explains why the system refuses two publications with one provider id.',
        audience: 'engineers',
        platforms: ['x'],
        formats: ['x_post'],
        hook: 'Two publications cannot share one post.',
        evidence_required: false,
        dedupe_hash: contentHash(newId('contentIdea')),
        rejection_reason: null,
        score: 0.5,
        prompt_version: 'ideation.v1',
      });
      const { item } = await contentItems.insertContentItemVersion(db.db, {
        id: newId('contentItem'),
        content_idea_id: idea.id,
        content_atom_id: atom.id,
        learning_event_id: event.id,
        platform: 'x',
        format: 'x_post',
        draft: {
          hook: 'Two publications cannot share one post.',
          units: [
            {
              index: 0,
              text: 'A provider id is the only handle we have on a published post, so two publications claiming the same id is a contradiction rather than a retry.',
              note: null,
            },
          ],
          body: 'A provider id is the only handle we have on a published post, so two publications claiming the same id is a contradiction rather than a retry.',
          hashtags: [],
          call_to_action: null,
          source_attributions: [],
        },
        prompt_id: 'x_post',
        prompt_version: 'x-post.v1',
        model: 'mock',
        correlation_id: event.correlation_id,
      });
      await contentItems.setContentItemStatus(db.db, item.id, 'gated');
      await contentItems.setContentItemStatus(db.db, item.id, 'pending_approval');
      await contentItems.setContentItemStatus(db.db, item.id, 'approved');
      return item;
    };

    const first = await makeApproved();
    const second = await makeApproved();

    const ok = await schedulePublication(ctx, first.id, { publisher: confused, scheduledAt: SLOT });
    expect(ok.ok).toBe(true);

    const clash = await schedulePublication(ctx, second.id, {
      publisher: confused,
      scheduledAt: SLOT,
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.error.code).toBe('E_PUBLISH_DUPLICATE_EXTERNAL_ID');

    const rows = await publicationsRepo.listPublicationsForItem(db.db, second.id);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.last_error).toContain('already recorded');

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors.some((e) => e.code === 'E_PUBLISH_DUPLICATE_EXTERNAL_ID')).toBe(true);
  });
});
