import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentIdeas,
  contentItems,
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
import { canonicalizeText } from '@sce/utils';
import type { ContentFormat } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import { buildContentAtom } from './atom.js';
import { generateIdeas } from './ideation.js';
import { generateContentItems } from './generate.js';
import { processLearningEvent } from './process-learning.js';
import { similarity } from './dedupe.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

const RICH_NOTE = `Mistake I made: I used Redis SETNX locks as a job queue. Locks expire, so when a
worker pauses longer than the TTL two workers believe they hold the same lock and the job runs
twice. A queue needs durable state and an explicit claim with a visibility timeout, which is why
SELECT ... FOR UPDATE SKIP LOCKED in Postgres works better for this.`;

const ALL_FORMATS: ContentFormat[] = [
  'x_post',
  'x_thread',
  'linkedin_post',
  'reel_script',
  'carousel',
];

describeDb('platform content generation', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const llm: LlmAdapter = createMockLlmAdapter();

  const readyIdea = async (text = RICH_NOTE) => {
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
    const processed = await processLearningEvent(ctx, event.id, { llm });
    if (!processed.ok || !processed.value.atom) throw new Error('setup: processing failed');
    const built = await buildContentAtom(ctx, processed.value.atom.id, { llm });
    if (!built.ok) throw new Error('setup: atom build failed');
    const ideas = await generateIdeas(ctx, built.value.atom.id, { llm });
    if (!ideas.ok || ideas.value.created.length === 0) throw new Error('setup: ideation failed');
    return { idea: ideas.value.created[0]!, atom: built.value.atom, event };
  };

  beforeAll(async () => {
    db = await createTestDb('generation');
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

  it('generates every target format with provenance and prompt version recorded', async () => {
    const { idea, atom, event } = await readyIdea();
    const result = await generateContentItems(ctx, idea.id, { llm, formats: ALL_FORMATS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failures).toEqual([]);
    expect(result.value.items).toHaveLength(ALL_FORMATS.length);

    for (const { item } of result.value.items) {
      expect(item.content_idea_id).toBe(idea.id);
      expect(item.content_atom_id).toBe(atom.id);
      expect(item.learning_event_id).toBe(event.id);
      expect(item.version).toBe(1);
      expect(item.status).toBe('draft');
      expect(item.prompt_version).toMatch(/\.v1$/);
      expect(item.model).toBeTruthy();
      expect(item.draft.body.length).toBeGreaterThan(0);
    }
  });

  it('produces genuinely platform-native formats, not copies of one another', async () => {
    const { idea } = await readyIdea();
    const result = await generateContentItems(ctx, idea.id, { llm, formats: ALL_FORMATS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byFormat = new Map(result.value.items.map((i) => [i.item.format, i.item]));

    // Structure differs: single-unit posts vs multi-unit thread/slides/beats.
    expect(byFormat.get('x_post')!.draft.units).toHaveLength(1);
    expect(byFormat.get('linkedin_post')!.draft.units).toHaveLength(1);
    expect(byFormat.get('x_thread')!.draft.units.length).toBeGreaterThan(2);
    expect(byFormat.get('carousel')!.draft.units.length).toBeGreaterThanOrEqual(5);
    expect(byFormat.get('reel_script')!.draft.units.length).toBeGreaterThanOrEqual(3);

    // Reel beats are time-coded; carousel slides carry visual direction.
    expect(byFormat.get('reel_script')!.draft.units[0]!.text).toMatch(/^\[\d+-\d+s\]/);
    expect(byFormat.get('carousel')!.draft.units.every((u) => u.note !== null)).toBe(true);

    // And the rendered bodies are not near-identical text.
    const x = canonicalizeText(byFormat.get('x_post')!.draft.body);
    const linkedin = canonicalizeText(byFormat.get('linkedin_post')!.draft.body);
    const carousel = canonicalizeText(byFormat.get('carousel')!.draft.body);
    expect(byFormat.get('linkedin_post')!.draft.body.length).toBeGreaterThan(
      byFormat.get('x_post')!.draft.body.length,
    );
    expect(similarity(x, linkedin)).toBeLessThan(0.95);
    expect(similarity(x, carousel)).toBeLessThan(0.95);
  });

  it('respects each platform hard limit', async () => {
    const { idea } = await readyIdea();
    const result = await generateContentItems(ctx, idea.id, { llm, formats: ALL_FORMATS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const { item } of result.value.items) {
      const limit =
        item.format === 'linkedin_post'
          ? 3000
          : item.format === 'carousel'
            ? 420
            : item.format === 'reel_script'
              ? 1800
              : 280;
      for (const unit of item.draft.units) {
        expect(unit.text.length, `${item.format} unit ${unit.index}`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('carries source attribution into every draft', async () => {
    const { idea, atom } = await readyIdea();
    const { source } = await import('@sce/db').then(async (db) =>
      db.sourceDocuments.insertSourceDocument(ctx.db, {
        id: newId('sourceDocument'),
        learning_event_id: atom.learning_event_id,
        content_atom_id: atom.id,
        title: 'PostgreSQL documentation: SELECT FOR UPDATE',
        url: 'https://postgresql.org/docs/16/sql-select.html',
        canonical_url: 'https://postgresql.org/docs/16/sql-select.html',
        source_type: 'official_docs',
        excerpt: 'SKIP LOCKED is used to obtain a lock only on rows that are not already locked.',
        summary: null,
        provider: 'scripted',
        relevance: 0.95,
      }),
    );

    const result = await generateContentItems(ctx, idea.id, { llm, formats: ['x_post'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const attributions = result.value.items[0]!.item.draft.source_attributions;
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({ source_id: source.id, url: source.canonical_url });
  });

  it('skips a format that already has a live draft, unless regenerating', async () => {
    const { idea } = await readyIdea();
    await generateContentItems(ctx, idea.id, { llm, formats: ['x_post'] });

    const second = await generateContentItems(ctx, idea.id, { llm, formats: ['x_post'] });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.skipped).toEqual(['x_post']);
    expect(second.value.items).toHaveLength(0);
  });

  it('regeneration creates a new version and supersedes the old one, preserving history', async () => {
    const { idea } = await readyIdea();
    const first = await generateContentItems(ctx, idea.id, { llm, formats: ['x_post'] });
    const second = await generateContentItems(ctx, idea.id, {
      llm,
      formats: ['x_post'],
      regenerate: true,
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const original = first.value.items[0]!.item;
    const regenerated = second.value.items[0]!.item;
    expect(regenerated.version).toBe(2);
    expect(second.value.items[0]!.superseded_id).toBe(original.id);

    const stored = await contentItems.listItemsForIdea(db.db, idea.id);
    expect(stored).toHaveLength(2);
    const old = stored.find((i) => i.id === original.id)!;
    expect(old.status).toBe('superseded');
    expect(old.superseded_by).toBe(regenerated.id);
    expect(old.draft).toEqual(original.draft); // history intact, not overwritten
  });

  it('rejects a draft that breaks a platform limit instead of storing it', async () => {
    const overlong = createMockLlmAdapter({
      handlers: {
        'x-post.v1': () => ({
          hook: 'A hook',
          units: [{ index: 0, text: 'x'.repeat(400), note: null }],
          hashtags: [],
          call_to_action: null,
        }),
      },
    });

    const { idea } = await readyIdea();
    const result = await generateContentItems(ctx, idea.id, { llm: overlong, formats: ['x_post'] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(0);
    expect(result.value.failures[0]).toMatchObject({ format: 'x_post', code: 'E_DRAFT_INVALID' });
    expect(result.value.failures[0]!.errors![0]!.code).toBe('UNIT_TOO_LONG');

    const stored = await contentItems.listItemsForIdea(db.db, idea.id);
    expect(stored).toHaveLength(0);

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors.some((e) => e.code === 'E_DRAFT_INVALID')).toBe(true);
  });

  it('rejects a thread with too few units', async () => {
    const stunted = createMockLlmAdapter({
      handlers: {
        'x-thread.v1': () => ({
          hook: 'A hook',
          units: [{ index: 0, text: 'Only one post in a thread.', note: null }],
          hashtags: [],
          call_to_action: null,
        }),
      },
    });

    const { idea } = await readyIdea();
    const result = await generateContentItems(ctx, idea.id, {
      llm: stunted,
      formats: ['x_thread'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failures[0]!.errors!.some((e) => e.code === 'TOO_FEW_UNITS')).toBe(true);
  });

  it('warns about banned phrases without blocking generation', async () => {
    const hypey = createMockLlmAdapter({
      handlers: {
        'x-post.v1': () => ({
          hook: 'This changed everything about how I think about queues.',
          units: [
            {
              index: 0,
              text: 'A game changer for job queues: locks that expire are not claims.',
              note: null,
            },
          ],
          hashtags: ['#buildinpublic'],
          call_to_action: null,
        }),
      },
    });

    const { idea } = await readyIdea();
    const result = await generateContentItems(ctx, idea.id, { llm: hypey, formats: ['x_post'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const warnings = result.value.items[0]!.warnings.map((w) => w.code);
    expect(warnings).toContain('BANNED_PHRASE');
    expect(warnings).toContain('HASHTAGS_ON_X');
    expect(result.value.items[0]!.item.status).toBe('draft'); // gate decides, not the generator
  });

  it('continues with other formats when one fails', async () => {
    const partial = createMockLlmAdapter({
      handlers: {
        'x-post.v1': () => ({ nonsense: true }),
      },
    });

    const { idea } = await readyIdea();
    const result = await generateContentItems(ctx, idea.id, {
      llm: partial,
      formats: ['x_post', 'linkedin_post'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failures.map((f) => f.format)).toEqual(['x_post']);
    expect(result.value.items.map((i) => i.item.format)).toEqual(['linkedin_post']);
  });

  it('records a failure when the model is unreachable and stores nothing', async () => {
    const { idea } = await readyIdea();
    const result = await generateContentItems(ctx, idea.id, {
      llm: createFailingLlmAdapter(),
      formats: ['x_post'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(0);
    expect(result.value.failures[0]!.code).toBe('E_LLM_UNREACHABLE');

    const stored = await contentItems.listItemsForIdea(db.db, idea.id);
    expect(stored).toHaveLength(0);
  });

  it('marks the idea used once drafts exist', async () => {
    const { idea } = await readyIdea();
    await generateContentItems(ctx, idea.id, { llm, formats: ['x_post'] });

    const updated = await contentIdeas.findIdea(db.db, idea.id);
    expect(updated?.status).toBe('used');
  });

  it('refuses to generate from an unknown idea', async () => {
    const result = await generateContentItems(ctx, 'ci_missing', { llm });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_IDEA_NOT_FOUND');
  });
});

describeDb('draft self-repetition', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const llm: LlmAdapter = createMockLlmAdapter();

  beforeAll(async () => {
    db = await createTestDb('generation_repetition');
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

  const setup = async () => {
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: RICH_NOTE,
      title: null,
      content_hash: contentHash(`${RICH_NOTE}${newId('learningEvent')}`),
      tags: [],
      context: {},
      captured_at: new Date().toISOString(),
      correlation_id: newCorrelationId(),
    });
    const processed = await processLearningEvent(ctx, event.id, { llm });
    if (!processed.ok || !processed.value.atom) throw new Error('setup failed');
    const built = await buildContentAtom(ctx, processed.value.atom.id, { llm });
    if (!built.ok) throw new Error('setup failed');
    const ideas = await generateIdeas(ctx, built.value.atom.id, { llm });
    if (!ideas.ok) throw new Error('setup failed');
    return ideas.value.created[0]!;
  };

  it('flags a thread that repeats a post', async () => {
    await db.truncate();
    const idea = await setup();
    const repeater = createMockLlmAdapter({
      handlers: {
        'x-thread.v1': () => ({
          hook: 'Locks that expire are not claims.',
          units: [
            { index: 0, text: 'Locks expire, so two workers can hold the same lock.', note: null },
            { index: 1, text: 'Locks expire, so two workers can hold the same lock!', note: null },
            { index: 2, text: 'Use SELECT ... FOR UPDATE SKIP LOCKED instead.', note: null },
          ],
          hashtags: [],
          call_to_action: null,
        }),
      },
    });

    const result = await generateContentItems(ctx, idea.id, {
      llm: repeater,
      formats: ['x_thread'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warnings = result.value.items[0]!.warnings;
    expect(warnings.map((w) => w.code)).toContain('DUPLICATE_UNIT');
  });

  it('the mock generator itself never emits a repeated unit', async () => {
    await db.truncate();
    const idea = await setup();
    const result = await generateContentItems(ctx, idea.id, {
      llm,
      formats: ['x_thread', 'carousel', 'reel_script'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const { item, warnings } of result.value.items) {
      expect(
        warnings.map((w) => w.code),
        item.format,
      ).not.toContain('DUPLICATE_UNIT');
    }
  });
});
