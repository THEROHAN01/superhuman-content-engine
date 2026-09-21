import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentIdeas,
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
import { buildContentAtom } from './atom.js';
import { generateIdeas, ideaDedupeHash, queueBestIdeas, scoreIdea } from './ideation.js';
import { processLearningEvent } from './process-learning.js';
import { NOTE_FIXTURES } from '../../../tests/fixtures/learning-notes.js';
import type { ContentIdeaDraft } from '@sce/schemas';

const describeDb = hasTestDatabase() ? describe : describe.skip;

const draft = (overrides: Partial<ContentIdeaDraft> = {}): ContentIdeaDraft => ({
  angle: 'insight',
  title: 'Why refresh token rotation matters',
  rationale: 'States the mechanism directly for a reader who wants the reason.',
  audience: 'backend engineers',
  platforms: ['x'],
  formats: ['x_post'],
  hook: 'A stolen refresh token looks exactly like a legitimate one - until you rotate.',
  evidence_required: true,
  ...overrides,
});

describe('idea scoring and hashing', () => {
  it('hashes identically for the same idea and differently for a different angle', () => {
    expect(ideaDedupeHash(draft())).toBe(ideaDedupeHash(draft()));
    expect(ideaDedupeHash(draft())).not.toBe(ideaDedupeHash(draft({ angle: 'mental_model' })));
  });

  it('ignores capitalization and punctuation noise', () => {
    expect(ideaDedupeHash(draft({ title: 'WHY refresh-token rotation MATTERS!' }))).toBe(
      ideaDedupeHash(draft()),
    );
  });

  it('penalises an evidence-hungry idea whose atom has no evidence', () => {
    const supported = scoreIdea(draft(), 'supported');
    const unsupported = scoreIdea(draft(), 'unsupported');
    expect(supported).toBeGreaterThan(unsupported);
  });

  it('keeps every score inside 0..1', () => {
    for (const status of [
      'supported',
      'unsupported',
      'needs_review',
      'research_failed',
      'not_required',
    ]) {
      const score = scoreIdea(draft({ angle: 'project_story', evidence_required: false }), status);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describeDb('ideation engine', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const llm: LlmAdapter = createMockLlmAdapter();

  const readyAtom = async (text: string) => {
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
    if (!processed.ok || !processed.value.atom) throw new Error('setup failed');
    const built = await buildContentAtom(ctx, processed.value.atom.id, { llm });
    if (!built.ok) throw new Error('setup failed: atom build');
    return built.value.atom;
  };

  beforeAll(async () => {
    db = await createTestDb('ideation');
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

  it('produces several distinct angles from one atom, each tracing back to it', async () => {
    const atom = await readyAtom(NOTE_FIXTURES[2]!.text); // has a failure mode and a personal note
    const result = await generateIdeas(ctx, atom.id, { llm });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created.length).toBeGreaterThan(1);
    const angles = result.value.created.map((i) => i.angle);
    expect(new Set(angles).size).toBe(angles.length); // no repeated angle
    for (const idea of result.value.created) {
      expect(idea.content_atom_id).toBe(atom.id);
      expect(idea.learning_event_id).toBe(atom.learning_event_id);
      expect(idea.prompt_version).toBe('ideation.v1');
      expect(idea.rationale.length).toBeGreaterThan(10);
    }
  });

  it('is idempotent: re-running without force returns the same ideas', async () => {
    const atom = await readyAtom(NOTE_FIXTURES[0]!.text);
    const first = await generateIdeas(ctx, atom.id, { llm });
    const second = await generateIdeas(ctx, atom.id, { llm });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.unchanged).toBe(true);
    expect(second.value.created).toHaveLength(0);
    expect(second.value.ideas.map((i) => i.id).sort()).toEqual(
      first.value.ideas.map((i) => i.id).sort(),
    );
  });

  it('does not grow the idea list without bound when forced repeatedly', async () => {
    const atom = await readyAtom(NOTE_FIXTURES[2]!.text);
    await generateIdeas(ctx, atom.id, { llm });

    for (let i = 0; i < 5; i++) {
      await generateIdeas(ctx, atom.id, { llm, force: true });
    }

    const ideas = await contentIdeas.listIdeasForAtom(db.db, atom.id);
    expect(ideas.length).toBeLessThanOrEqual(8);

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM content_ideas',
    );
    expect(rows[0]!.count).toBe(ideas.length);
  });

  it('rejects a near-duplicate idea with a stated reason', async () => {
    const atom = await readyAtom(NOTE_FIXTURES[0]!.text);
    await generateIdeas(ctx, atom.id, { llm });

    const echo = createMockLlmAdapter({
      handlers: {
        'ideation.v1': () => ({
          ideas: [
            {
              ...draft({
                title: 'Why refresh-token rotation matters',
                hook: 'A stolen refresh token looks exactly like a legitimate one until you rotate.',
              }),
            },
          ],
        }),
      },
    });

    const existing = await contentIdeas.listIdeasForAtom(db.db, atom.id);
    const repeat = createMockLlmAdapter({
      handlers: {
        'ideation.v1': () => ({
          ideas: [
            {
              angle: existing[0]!.angle,
              title: existing[0]!.title,
              rationale: 'Same idea, different words.',
              audience: existing[0]!.audience,
              platforms: existing[0]!.platforms,
              formats: existing[0]!.formats,
              hook: existing[0]!.hook,
              evidence_required: existing[0]!.evidence_required,
            },
          ],
        }),
      },
    });

    const result = await generateIdeas(ctx, atom.id, { llm: repeat, force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toHaveLength(0);
    expect(result.value.rejected).toHaveLength(1);
    expect(result.value.rejected[0]!.reason).toMatch(/no new information|already exists/);
    void echo;
  });

  it('refuses an angle the atom cannot support', async () => {
    const atom = await readyAtom(
      'Refresh token rotation invalidates the previous token on every refresh, which turns a replayed token into a detectable signal.',
    );
    const overreach = createMockLlmAdapter({
      handlers: {
        'ideation.v1': () => ({
          ideas: [
            draft({ angle: 'failure_mode', title: 'The outage this caused' }),
            draft({ angle: 'project_story', title: 'How I shipped this last week' }),
          ],
        }),
      },
    });

    const result = await generateIdeas(ctx, atom.id, { llm: overreach });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toHaveLength(0);
    expect(result.value.rejected.map((r) => r.reason)).toEqual([
      'atom has no failure mode to write about',
      'atom has no personal observation to tell a story from',
    ]);
  });

  it('refuses to ideate from an atom that is not ready', async () => {
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: NOTE_FIXTURES[1]!.text,
      title: null,
      content_hash: contentHash(NOTE_FIXTURES[1]!.text),
      tags: [],
      context: {},
      captured_at: new Date().toISOString(),
      correlation_id: newCorrelationId(),
    });
    const processed = await processLearningEvent(ctx, event.id, { llm });
    const shellId = processed.ok ? processed.value.atom!.id : '';

    const result = await generateIdeas(ctx, shellId, { llm });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_ATOM_NOT_READY');
  });

  it('records a failure instead of inventing ideas when the model is down', async () => {
    const atom = await readyAtom(NOTE_FIXTURES[0]!.text);
    const result = await generateIdeas(ctx, atom.id, { llm: createFailingLlmAdapter() });

    expect(result.ok).toBe(false);
    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors.some((e) => e.workflow === 'content_ideate_v1')).toBe(true);

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM content_ideas',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('routes the strongest ideas into the content queue', async () => {
    const atom = await readyAtom(NOTE_FIXTURES[2]!.text);
    await generateIdeas(ctx, atom.id, { llm });

    const queued = await queueBestIdeas(ctx, atom.id, 2);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((i) => i.status === 'queued')).toBe(true);

    const all = await contentIdeas.listIdeasForAtom(db.db, atom.id);
    expect(all.filter((i) => i.status === 'queued')).toHaveLength(queued.length);
  });

  it('records a workflow run for each ideation attempt', async () => {
    const atom = await readyAtom(NOTE_FIXTURES[0]!.text);
    await generateIdeas(ctx, atom.id, { llm });

    const runs = await operations.listWorkflowRuns(db.db, { workflow: 'content_ideate_v1' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', subject_id: atom.id });
  });
});
