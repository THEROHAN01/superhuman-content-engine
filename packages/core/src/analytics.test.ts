import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  analytics as analyticsRepo,
  contentAtoms,
  contentIdeas,
  contentItems,
  createTestDb,
  hasTestDatabase,
  learningEvents,
  operations,
  type TestDb,
} from '@sce/db';
import {
  createFailingAnalyticsAdapter,
  createMockAnalyticsAdapter,
  createMockPublishingAdapter,
  EMPTY_METRICS,
  type AnalyticsAdapter,
} from '@sce/adapters';
import {
  contentHash,
  createLogger,
  fixedClock,
  newCorrelationId,
  newId,
  parseEnv,
} from '@sce/utils';
import type { Publication } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import { collectAnalytics, collectDuePublications, deriveMetrics } from './analytics.js';
import { markPublished, schedulePublication } from './publish.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describe('deriveMetrics', () => {
  it('returns null ratios when the denominator is unknown', () => {
    expect(deriveMetrics({ ...EMPTY_METRICS, reactions: 12, comments: 3 })).toEqual({
      engagement_rate: null,
      comment_rate: null,
      save_rate: null,
    });
  });

  it('returns null ratios when the denominator is zero', () => {
    expect(
      deriveMetrics({ ...EMPTY_METRICS, impressions: 0, reactions: 5 }).engagement_rate,
    ).toBeNull();
  });

  it('computes ratios when impressions are known', () => {
    const derived = deriveMetrics({
      ...EMPTY_METRICS,
      impressions: 1000,
      reactions: 40,
      comments: 10,
      shares: 5,
    });
    expect(derived.engagement_rate).toBeCloseTo(0.055, 5);
    expect(derived.comment_rate).toBeCloseTo(0.01, 5);
    expect(derived.save_rate).toBeNull(); // saves unknown -> rate unknown, not zero
  });

  it('falls back to reach when impressions are unavailable', () => {
    const derived = deriveMetrics({ ...EMPTY_METRICS, reach: 500, reactions: 25 });
    expect(derived.engagement_rate).toBeCloseTo(0.05, 5);
  });

  it('ignores unknown components rather than treating them as zero', () => {
    const withUnknown = deriveMetrics({ ...EMPTY_METRICS, impressions: 100, reactions: 10 });
    const withZero = deriveMetrics({
      ...EMPTY_METRICS,
      impressions: 100,
      reactions: 10,
      comments: 0,
      shares: 0,
    });
    expect(withUnknown.engagement_rate).toBe(withZero.engagement_rate);
    expect(withUnknown.comment_rate).toBeNull();
    expect(withZero.comment_rate).toBe(0);
  });
});

describeDb('analytics collection', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const adapter: AnalyticsAdapter = createMockAnalyticsAdapter();
  // One publisher for the whole suite, as in a real deployment: provider ids stay unique.
  const publisher = createMockPublishingAdapter();

  const publishedPublication = async (
    platform: 'x' | 'linkedin' | 'instagram' = 'x',
  ): Promise<Publication> => {
    const text = `note ${newId('learningEvent')} about analytics honesty`;
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: 'Analytics',
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
      title: 'Unknown is not zero',
      kind: 'core_engineering',
      primary_topic: 'observability',
      secondary_topics: [],
      entities: [],
      body: {
        problem: 'Why not default missing metrics to zero?',
        core_insight: 'A zero is a measurement; a null is an admission.',
        first_principles: 'Averages over fabricated zeroes are wrong in a way nobody can see.',
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
      title: 'Unknown is not zero',
      rationale: 'Explains a data-modelling decision.',
      audience: 'engineers',
      platforms: [platform],
      formats: ['x_post'],
      hook: 'A zero is a measurement.',
      evidence_required: false,
      dedupe_hash: contentHash(newId('contentIdea')),
      rejection_reason: null,
      score: 0.7,
      prompt_version: 'ideation.v1',
    });
    const body =
      'A zero is a measurement; a null is an admission. Defaulting unknown metrics to zero quietly corrupts every average built on them.';
    const { item } = await contentItems.insertContentItemVersion(db.db, {
      id: newId('contentItem'),
      content_idea_id: idea.id,
      content_atom_id: atom.id,
      learning_event_id: event.id,
      platform,
      format: 'x_post',
      draft: {
        hook: 'A zero is a measurement.',
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

    await contentItems.setContentItemStatus(db.db, item.id, 'gated');
    await contentItems.setContentItemStatus(db.db, item.id, 'pending_approval');
    await contentItems.setContentItemStatus(db.db, item.id, 'approved');

    const scheduled = await schedulePublication(ctx, item.id, {
      publisher,
      scheduledAt: '2026-09-22T09:00:00.000Z',
    });
    if (!scheduled.ok) throw new Error('setup: scheduling failed');
    const published = await markPublished(ctx, scheduled.value.publication.id);
    if (!published.ok) throw new Error('setup: publishing failed');
    return published.value;
  };

  beforeAll(async () => {
    db = await createTestDb('analytics');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-23T12:00:00.000Z'),
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
    publisher.reset();
  });

  it('collects metrics and links them back to the item and the learning event', async () => {
    const publication = await publishedPublication();
    const result = await collectAnalytics(ctx, publication.id, { analytics: adapter });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inserted).toBe(true);
    expect(result.value.event.publication_id).toBe(publication.id);
    expect(result.value.event.content_item_id).toBe(publication.content_item_id);
    expect(result.value.event.learning_event_id).toBe(publication.learning_event_id);
    expect(result.value.event.collected_for).toBe('2026-09-23');
    expect(result.value.event.metrics.impressions).toBeGreaterThan(0);
  });

  it('leaves metrics the platform cannot report as null, never zero', async () => {
    const publication = await publishedPublication('x');
    const result = await collectAnalytics(ctx, publication.id, { analytics: adapter });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const metrics = result.value.event.metrics;
    // X does not expose saves or video views through this path.
    expect(metrics.saves).toBeNull();
    expect(metrics.video_views).toBeNull();
    expect(metrics.reach).toBeNull();
    // And at least one supported metric is deliberately unknown too.
    expect(Object.values(metrics).some((value) => value === null)).toBe(true);
  });

  it('reports different metric sets per platform', async () => {
    const x = await publishedPublication('x');
    const instagram = await publishedPublication('instagram');

    const xResult = await collectAnalytics(ctx, x.id, { analytics: adapter });
    const igResult = await collectAnalytics(ctx, instagram.id, { analytics: adapter });
    expect(xResult.ok && igResult.ok).toBe(true);
    if (!xResult.ok || !igResult.ok) return;

    expect(xResult.value.event.metrics.impressions).not.toBeNull();
    expect(igResult.value.event.metrics.reach).not.toBeNull();
    expect(igResult.value.event.metrics.impressions).toBeNull(); // instagram reports reach, not impressions
  });

  it('is deterministic for the same publication, window and day', async () => {
    const publication = await publishedPublication();
    const first = await collectAnalytics(ctx, publication.id, { analytics: adapter });
    const second = await collectAnalytics(ctx, publication.id, { analytics: adapter });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.inserted).toBe(false); // refreshed, not duplicated
    expect(second.value.event.metrics).toEqual(first.value.event.metrics);

    const rows = await analyticsRepo.listAnalyticsForPublication(db.db, publication.id);
    expect(rows).toHaveLength(1);
  });

  it('keeps separate rows per window and per day', async () => {
    const publication = await publishedPublication();
    await collectAnalytics(ctx, publication.id, { analytics: adapter, window: '24h' });
    await collectAnalytics(ctx, publication.id, { analytics: adapter, window: '7d' });
    await collectAnalytics(ctx, publication.id, {
      analytics: adapter,
      window: '24h',
      collectedFor: '2026-09-24',
    });

    const rows = await analyticsRepo.listAnalyticsForPublication(db.db, publication.id);
    expect(rows).toHaveLength(3);
  });

  it('records a failure instead of storing zeroes when the provider is down', async () => {
    const publication = await publishedPublication();
    const result = await collectAnalytics(ctx, publication.id, {
      analytics: createFailingAnalyticsAdapter(),
      attempts: 2,
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    const rows = await analyticsRepo.listAnalyticsForPublication(db.db, publication.id);
    expect(rows).toHaveLength(0);

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors.some((e) => e.workflow === 'analytics_collect_v1')).toBe(true);

    const runs = await operations.listWorkflowRuns(db.db, { workflow: 'analytics_collect_v1' });
    expect(runs[0]?.status).toBe('failed');
  });

  it('refuses to measure a publication that never reached a provider', async () => {
    const publication = await publishedPublication();
    await db.db.query(`UPDATE publications SET external_id = NULL WHERE id = $1`, [publication.id]);

    const result = await collectAnalytics(ctx, publication.id, { analytics: adapter });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_NO_EXTERNAL_ID');
  });

  it('refuses to measure a cancelled publication', async () => {
    const publication = await publishedPublication();
    await db.db.query(`UPDATE publications SET status = 'cancelled' WHERE id = $1`, [
      publication.id,
    ]);

    const result = await collectAnalytics(ctx, publication.id, { analytics: adapter });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_NOT_PUBLISHED');
  });

  it('keeps the raw provider payload for traceability', async () => {
    const publication = await publishedPublication();
    const result = await collectAnalytics(ctx, publication.id, { analytics: adapter });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event.raw_payload).not.toBeNull();
    expect(result.value.simulated).toBe(true);
  });

  it('sweeps every measurable publication and survives one provider failure', async () => {
    await publishedPublication();
    await publishedPublication();
    const broken = await publishedPublication();
    await db.db.query(`UPDATE publications SET external_id = NULL WHERE id = $1`, [broken.id]);

    const sweep = await collectDuePublications(ctx, { analytics: adapter });
    expect(sweep.attempted).toBe(2); // the one without a provider id is not attempted
    expect(sweep.collected).toBe(2);
    expect(sweep.failed).toHaveLength(0);

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM analytics_events',
    );
    expect(rows[0]!.count).toBe(2);
  });

  it('a sweep reports failures without stopping', async () => {
    await publishedPublication();
    await publishedPublication();

    const sweep = await collectDuePublications(ctx, {
      analytics: createFailingAnalyticsAdapter(),
      attempts: 1,
      sleep: async () => {},
    });
    expect(sweep.attempted).toBe(2);
    expect(sweep.collected).toBe(0);
    expect(sweep.failed).toHaveLength(2);
  });

  it('fails clearly for an unknown publication', async () => {
    const result = await collectAnalytics(ctx, 'pb_missing', { analytics: adapter });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_PUBLICATION_NOT_FOUND');
  });

  it('keeps publications reachable from analytics for provenance', async () => {
    const publication = await publishedPublication();
    await collectAnalytics(ctx, publication.id, { analytics: adapter });

    const { rows } = await db.db.query<{ learning_event_id: string }>(
      `SELECT ae.learning_event_id
       FROM analytics_events ae
       JOIN publications p ON p.id = ae.publication_id
       JOIN content_items ci ON ci.id = ae.content_item_id
       WHERE ae.publication_id = $1`,
      [publication.id],
    );
    expect(rows[0]!.learning_event_id).toBe(publication.learning_event_id);
  });
});
