import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  analytics as analyticsRepo,
  contentAtoms,
  contentIdeas,
  contentItems,
  createTestDb,
  hasTestDatabase,
  learningEvents,
  publications as publicationsRepo,
  weeklyReports as weeklyReportsRepo,
  type TestDb,
} from '@sce/db';
import {
  createFailingTelegramAdapter,
  createMockTelegramAdapter,
  EMPTY_METRICS,
} from '@sce/adapters';
import {
  contentHash,
  createLogger,
  fixedClock,
  idempotencyKey,
  newCorrelationId,
  newId,
  parseEnv,
} from '@sce/utils';
import type { NormalizedMetrics, Platform, Topic } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import {
  classifyHook,
  deliverWeeklyReport,
  generateWeeklyReport,
  isoWeekKey,
  renderWeeklyReport,
  weekWindow,
} from './weekly-report.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

/** Thursday of ISO week 2026-W39, so the seeded week is unambiguous. */
const NOW = new Date('2026-09-24T12:00:00.000Z');
const IN_WEEK = '2026-09-22T10:00:00.000Z';
const BEFORE_WEEK = '2026-09-14T10:00:00.000Z';

describe('report window', () => {
  it('computes an ISO week key', () => {
    expect(isoWeekKey(NOW, 'UTC')).toBe('2026-W39');
  });

  it('gives the same key for every day of the same week', () => {
    const keys = ['2026-09-21T00:30:00Z', '2026-09-24T12:00:00Z', '2026-09-27T23:00:00Z'].map((d) =>
      isoWeekKey(new Date(d), 'UTC'),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('spans exactly seven days', () => {
    const window = weekWindow(NOW, 'UTC');
    expect(window.end.getTime() - window.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('hook classification', () => {
  it.each([
    ['Mistake I made: I used Redis locks as a queue.', 'confession'],
    ['Why does rotation detect replay?', 'question'],
    ['3 ms of latency came from the connection pool', 'number'],
    ['Never use a lock as a queue', 'imperative'],
    ['Rotation works because the old token is invalidated', 'mechanism'],
    ['Partial indexes are useful', 'statement'],
  ])('%s -> %s', (hook, expected) => {
    expect(classifyHook(hook)).toBe(expected);
  });
});

describeDb('weekly report', () => {
  let db: TestDb;
  let ctx: ServiceContext;

  /** Seeds one full chain: learning event -> atom -> idea -> item -> publication -> analytics. */
  const seedChain = async (options: {
    topic: Topic;
    platform: Platform;
    format: string;
    hook: string;
    capturedAt: string;
    publishedAt: string | null;
    metrics?: Partial<NormalizedMetrics> | null;
  }) => {
    const text = `note ${newId('learningEvent')} for ${options.topic}`;
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: `Learning about ${options.topic}`,
      content_hash: contentHash(text),
      tags: [],
      context: {},
      captured_at: options.capturedAt,
      correlation_id: newCorrelationId(),
    });
    const { atom } = await contentAtoms.upsertContentAtom(db.db, {
      id: newId('contentAtom'),
      learning_event_id: event.id,
      status: 'ready',
      title: `Atom about ${options.topic}`,
      kind: 'core_engineering',
      primary_topic: options.topic,
      secondary_topics: [],
      entities: [],
      body: {
        problem: 'A question worth answering here.',
        core_insight: 'The insight that makes it click.',
        first_principles: 'The mechanism underneath it all.',
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
      title: `Idea about ${options.topic}`,
      rationale: 'It explains the mechanism directly.',
      audience: 'engineers',
      platforms: [options.platform],
      formats: [options.format],
      hook: options.hook,
      evidence_required: false,
      dedupe_hash: contentHash(newId('contentIdea')),
      rejection_reason: null,
      score: 0.7,
      prompt_version: 'ideation.v1',
    });
    const body = `A body about ${options.topic} that is long enough to be a real draft for the report.`;
    const { item } = await contentItems.insertContentItemVersion(db.db, {
      id: newId('contentItem'),
      content_idea_id: idea.id,
      content_atom_id: atom.id,
      learning_event_id: event.id,
      platform: options.platform,
      format: options.format as 'x_post',
      draft: {
        hook: options.hook,
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
    await db.db.query(`UPDATE content_items SET created_at = $2 WHERE id = $1`, [
      item.id,
      options.capturedAt,
    ]);

    if (!options.publishedAt) return { event, atom, idea, item, publication: null };

    const { publication } = await publicationsRepo.claimPublication(db.db, {
      id: newId('publication'),
      content_item_id: item.id,
      learning_event_id: event.id,
      platform: options.platform,
      idempotency_key: idempotencyKey(item.id, options.platform, options.publishedAt),
      provider: 'mock',
      scheduled_at: options.publishedAt,
      dry_run: true,
      correlation_id: event.correlation_id,
    });
    await publicationsRepo.setPublicationStatus(db.db, publication.id, 'scheduled', {
      external_id: `ext-${publication.id}`,
    });
    await publicationsRepo.setPublicationStatus(db.db, publication.id, 'published', {
      published_at: options.publishedAt,
    });

    if (options.metrics !== null && options.metrics !== undefined) {
      await analyticsRepo.upsertAnalyticsEvent(db.db, {
        id: newId('analyticsEvent'),
        publication_id: publication.id,
        content_item_id: item.id,
        learning_event_id: event.id,
        platform: options.platform,
        metric_window: '24h',
        collected_for: options.publishedAt.slice(0, 10),
        provider: 'mock',
        metrics: { ...EMPTY_METRICS, ...options.metrics },
        raw_payload: null,
      });
    }

    return { event, atom, idea, item, publication };
  };

  beforeAll(async () => {
    db = await createTestDb('weekly_report');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
        TZ: 'UTC',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock(NOW.toISOString()),
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it('counts only what happened inside the reporting window', async () => {
    await seedChain({
      topic: 'security',
      platform: 'x',
      format: 'x_post',
      hook: 'Rotation works because the old token dies',
      capturedAt: IN_WEEK,
      publishedAt: IN_WEEK,
      metrics: { impressions: 1000, reactions: 40, comments: 5, shares: 5 },
    });
    await seedChain({
      topic: 'databases',
      platform: 'linkedin',
      format: 'linkedin_post',
      hook: 'Mistake I made: I used a lock as a queue',
      capturedAt: BEFORE_WEEK,
      publishedAt: BEFORE_WEEK,
      metrics: { impressions: 5000, reactions: 400 },
    });

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const body = result.value.report.body;
    expect(result.value.report.period_key).toBe('2026-W39');
    expect(body.counts.learning_events).toBe(1); // the older chain is excluded
    expect(body.counts.published).toBe(1);
    expect(body.by_topic.map((g) => g.key)).toEqual(['security']);
  });

  it('reconciles its totals with the underlying rows', async () => {
    for (let i = 0; i < 3; i++) {
      await seedChain({
        topic: 'backend',
        platform: 'x',
        format: 'x_post',
        hook: `Hook number ${i} explains why it works`,
        capturedAt: IN_WEEK,
        publishedAt: i < 2 ? IN_WEEK : null,
        metrics: { impressions: 100 * (i + 1), reactions: 10 },
      });
    }

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.report.body;

    const dbCounts = await db.db.query<{
      events: number;
      atoms: number;
      items: number;
      published: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM learning_events) AS events,
        (SELECT count(*)::int FROM content_atoms) AS atoms,
        (SELECT count(*)::int FROM content_items) AS items,
        (SELECT count(*)::int FROM publications WHERE status = 'published') AS published`,
    );

    expect(body.counts.learning_events).toBe(dbCounts.rows[0]!.events);
    expect(body.counts.content_atoms).toBe(dbCounts.rows[0]!.atoms);
    expect(body.counts.drafts_generated).toBe(dbCounts.rows[0]!.items);
    expect(body.counts.published).toBe(dbCounts.rows[0]!.published);

    // Group totals add up to the number of published items.
    const topicTotal = body.by_topic.reduce((sum, group) => sum + group.published, 0);
    expect(topicTotal).toBe(body.counts.published);
  });

  it('keeps unknown metrics unknown rather than averaging them as zero', async () => {
    await seedChain({
      topic: 'performance',
      platform: 'x',
      format: 'x_post',
      hook: 'A hook about latency numbers',
      capturedAt: IN_WEEK,
      publishedAt: IN_WEEK,
      metrics: null, // published, never measured
    });

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const group = result.value.report.body.by_topic.find((g) => g.key === 'performance')!;
    expect(group.published).toBe(1);
    expect(group.impressions).toBeNull();
    expect(group.engagement_rate).toBeNull();
    expect(group.measured).toBe(0);

    const note = result.value.report.body.signals.find((s) =>
      s.statement.includes('no analytics yet'),
    );
    expect(note?.confidence).toBe('high');
  });

  it('does not claim a winner from a single measured post', async () => {
    await seedChain({
      topic: 'security',
      platform: 'x',
      format: 'x_post',
      hook: 'One measured post',
      capturedAt: IN_WEEK,
      publishedAt: IN_WEEK,
      metrics: { impressions: 900, reactions: 90 },
    });

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!result.ok) return;
    const signals = result.value.report.body.signals;
    expect(signals.some((s) => s.kind === 'strongest')).toBe(false);

    const note = signals.find((s) => s.statement.includes('not enough measured'))!;
    expect(note).toBeDefined();
    // The basis must not claim there were no usable metrics when there was one measured post.
    expect(note.basis).toContain('1 with known impressions');
    expect(note.basis).toContain('minimum');
  });

  it('ranks topics when enough measured posts exist, and states its basis', async () => {
    for (let i = 0; i < 2; i++) {
      await seedChain({
        topic: 'security',
        platform: 'x',
        format: 'x_post',
        hook: `Security hook ${i}`,
        capturedAt: IN_WEEK,
        publishedAt: IN_WEEK,
        metrics: { impressions: 1000, reactions: 100 },
      });
      await seedChain({
        topic: 'career',
        platform: 'x',
        format: 'x_post',
        hook: `Career hook ${i}`,
        capturedAt: IN_WEEK,
        publishedAt: IN_WEEK,
        metrics: { impressions: 1000, reactions: 5 },
      });
    }

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!result.ok) return;
    const signals = result.value.report.body.signals;

    const strongest = signals.find((s) => s.kind === 'strongest')!;
    const weakest = signals.find((s) => s.kind === 'weakest')!;
    expect(strongest.statement).toContain('security');
    expect(weakest.statement).toContain('career');
    // Four measured posts across two groups is still a small sample.
    expect(strongest.confidence).toBe('low');
    expect(strongest.basis).toContain('known impressions');
  });

  it('groups by format, platform and hook class', async () => {
    await seedChain({
      topic: 'backend',
      platform: 'x',
      format: 'x_post',
      hook: 'Mistake I made: the lock expired',
      capturedAt: IN_WEEK,
      publishedAt: IN_WEEK,
      metrics: { impressions: 500, reactions: 20 },
    });
    await seedChain({
      topic: 'backend',
      platform: 'linkedin',
      format: 'linkedin_post',
      hook: 'Why does the lock expire?',
      capturedAt: IN_WEEK,
      publishedAt: IN_WEEK,
      metrics: { impressions: 800, reactions: 30 },
    });

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!result.ok) return;
    const body = result.value.report.body;
    expect(body.by_format.map((g) => g.key).sort()).toEqual(['linkedin_post', 'x_post']);
    expect(body.by_platform.map((g) => g.key).sort()).toEqual(['linkedin', 'x']);
    expect(body.by_hook_class.map((g) => g.key).sort()).toEqual(['confession', 'question']);
  });

  it('measures capture-to-publish time when both timestamps exist', async () => {
    await seedChain({
      topic: 'backend',
      platform: 'x',
      format: 'x_post',
      hook: 'A hook',
      capturedAt: '2026-09-22T00:00:00.000Z',
      publishedAt: '2026-09-23T00:00:00.000Z',
      metrics: { impressions: 100 },
    });

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!result.ok) return;
    expect(result.value.report.body.capture_to_publish_hours).toBeCloseTo(24, 1);
  });

  it('reports unknown latency when nothing was published', async () => {
    await seedChain({
      topic: 'backend',
      platform: 'x',
      format: 'x_post',
      hook: 'A hook',
      capturedAt: IN_WEEK,
      publishedAt: null,
    });

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!result.ok) return;
    expect(result.value.report.body.capture_to_publish_hours).toBeNull();
  });

  it('surfaces the approval backlog and suggests unused material', async () => {
    const chain = await seedChain({
      topic: 'databases',
      platform: 'x',
      format: 'x_post',
      hook: 'A hook about indexes',
      capturedAt: IN_WEEK,
      publishedAt: null,
    });
    await contentItems.setContentItemStatus(db.db, chain.item.id, 'gated');
    await contentItems.setContentItemStatus(db.db, chain.item.id, 'pending_approval');
    await contentIdeas.setIdeaStatus(db.db, chain.idea.id, 'proposed');

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!result.ok) return;
    const body = result.value.report.body;

    expect(body.approval_backlog.map((row) => row.content_item_id)).toContain(chain.item.id);
    expect(body.content_opportunities.length).toBeGreaterThan(0);
    expect(body.learning_suggestions.some((s) => s.topic === 'databases')).toBe(true);
  });

  it('is reproducible: regenerating the same week replaces the report', async () => {
    await seedChain({
      topic: 'backend',
      platform: 'x',
      format: 'x_post',
      hook: 'A hook',
      capturedAt: IN_WEEK,
      publishedAt: IN_WEEK,
      metrics: { impressions: 100, reactions: 10 },
    });

    const first = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    const second = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.inserted).toBe(true);
    expect(second.value.inserted).toBe(false);
    expect(second.value.report.id).toBe(first.value.report.id);
    expect(second.value.report.body.counts).toEqual(first.value.report.body.counts);

    const all = await weeklyReportsRepo.listWeeklyReports(db.db);
    expect(all).toHaveLength(1);
  });

  it('keeps earlier weeks accessible', async () => {
    await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    await generateWeeklyReport(ctx, { at: new Date('2026-09-17T12:00:00Z'), timeZone: 'UTC' });

    const all = await weeklyReportsRepo.listWeeklyReports(db.db);
    expect(all.map((r) => r.period_key).sort()).toEqual(['2026-W38', '2026-W39']);
  });

  it('renders a report a human can read on a phone', async () => {
    await seedChain({
      topic: 'security',
      platform: 'x',
      format: 'x_post',
      hook: 'Rotation works because the old token dies',
      capturedAt: IN_WEEK,
      publishedAt: IN_WEEK,
      metrics: { impressions: 1000, reactions: 40 },
    });

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!result.ok) return;
    const text = renderWeeklyReport(result.value.report);

    expect(text).toContain('2026-W39');
    expect(text).toContain('Published: 1');
    expect(text).toContain('suggestions');
    expect(text.length).toBeLessThan(4096);
  });

  it('shows unknown rather than zero in the rendered report', async () => {
    await seedChain({
      topic: 'backend',
      platform: 'x',
      format: 'x_post',
      hook: 'A hook',
      capturedAt: IN_WEEK,
      publishedAt: IN_WEEK,
      metrics: null,
    });

    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!result.ok) return;
    const text = renderWeeklyReport(result.value.report);
    expect(text).toContain('impressions unknown');
  });

  it('delivers the report and records delivery, idempotently', async () => {
    const generated = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!generated.ok) return;
    const telegram = createMockTelegramAdapter();

    const first = await deliverWeeklyReport(ctx, generated.value.report.id, {
      telegram,
      chatId: '123',
    });
    const second = await deliverWeeklyReport(ctx, generated.value.report.id, {
      telegram,
      chatId: '123',
    });

    expect(first.ok && first.value.status).toBe('delivered');
    expect(second.ok && second.value.status).toBe('delivered');
    expect(telegram.sent).toHaveLength(1); // no second send
  });

  it('records a delivery failure without losing the report', async () => {
    const generated = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    if (!generated.ok) return;

    const result = await deliverWeeklyReport(ctx, generated.value.report.id, {
      telegram: createFailingTelegramAdapter(),
      chatId: '123',
    });
    expect(result.ok).toBe(false);

    const stored = await weeklyReportsRepo.findWeeklyReport(db.db, generated.value.report.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.delivery_error).toContain('E_TELEGRAM_UNREACHABLE');
    expect(stored?.body.counts).toBeDefined(); // the report itself survives
  });

  it('generates an empty-but-valid report for a quiet week', async () => {
    const result = await generateWeeklyReport(ctx, { at: NOW, timeZone: 'UTC' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.body.counts.learning_events).toBe(0);
    expect(result.value.report.body.by_topic).toEqual([]);
    expect(renderWeeklyReport(result.value.report)).toContain('Learning events: 0');
  });
});
