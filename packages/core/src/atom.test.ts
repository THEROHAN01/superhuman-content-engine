import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentAtoms,
  createTestDb,
  hasTestDatabase,
  learningEvents,
  operations,
  sourceDocuments,
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
import { processLearningEvent } from './process-learning.js';
import { NOTE_FIXTURES } from '../../../tests/fixtures/learning-notes.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('canonical content atom', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const llm: LlmAdapter = createMockLlmAdapter();

  /** Captures a note and runs it through classification, returning the atom shell. */
  const shellFor = async (text: string) => {
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
    if (!processed.ok || !processed.value.atom) throw new Error('fixture setup failed');
    return { event, atom: processed.value.atom };
  };

  const addSource = async (atomId: string, eventId: string, url: string) => {
    const { source } = await sourceDocuments.insertSourceDocument(db.db, {
      id: newId('sourceDocument'),
      learning_event_id: eventId,
      content_atom_id: atomId,
      title: 'Official documentation',
      url,
      canonical_url: url,
      source_type: 'official_docs',
      excerpt: 'Documented behaviour supporting the claim.',
      summary: null,
      provider: 'scripted',
      relevance: 0.9,
    });
    return source;
  };

  beforeAll(async () => {
    db = await createTestDb('atom_build');
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

  it('builds a ready atom that preserves provenance back to the learning event', async () => {
    const { event, atom } = await shellFor(NOTE_FIXTURES[0]!.text);
    const result = await buildContentAtom(ctx, atom.id, { llm });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const built = result.value.atom;
    expect(built.status).toBe('ready');
    expect(built.learning_event_id).toBe(event.id);
    expect(built.body.core_insight.length).toBeGreaterThan(10);
    expect(built.body.first_principles.length).toBeGreaterThan(10);
    expect(built.body.problem.length).toBeGreaterThan(10);
    expect(built.atomized_at).toBeTruthy();

    // The raw learning is still available and unchanged.
    const stored = await learningEvents.findLearningEvent(db.db, event.id);
    expect(stored?.raw_text).toBe(NOTE_FIXTURES[0]!.text);
  });

  it('keeps one atom per learning event', async () => {
    const { atom } = await shellFor(NOTE_FIXTURES[1]!.text);
    await buildContentAtom(ctx, atom.id, { llm });

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM content_atoms',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('is idempotent: rebuilding without force changes nothing', async () => {
    const { atom } = await shellFor(NOTE_FIXTURES[2]!.text);
    const first = await buildContentAtom(ctx, atom.id, { llm });
    const second = await buildContentAtom(ctx, atom.id, { llm });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.unchanged).toBe(true);
    expect(second.value.atom.body).toEqual(first.value.atom.body);
  });

  it('marks claims supported only when a real source is cited', async () => {
    const { event, atom } = await shellFor(NOTE_FIXTURES[0]!.text);
    await addSource(atom.id, event.id, 'https://rfc-editor.org/rfc/rfc6749');
    await contentAtoms.updateAtom(db.db, atom.id, { evidence_status: 'supported' });

    const result = await buildContentAtom(ctx, atom.id, { llm });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const claims = result.value.atom.body.claims;
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.status !== 'supported' || c.source_ids.length > 0)).toBe(true);
    expect(result.value.evidence_status).toBe('supported');
  });

  it('downgrades a claim that says "supported" while citing nothing', async () => {
    const liar = createMockLlmAdapter({
      handlers: {
        'atom.v1': () => ({
          problem: 'Why does this matter for token rotation?',
          core_insight: 'Rotation makes a stolen token detectable when it is replayed.',
          first_principles: 'A static credential cannot be distinguished from a stolen copy of it.',
          example: null,
          implementation_details: null,
          failure_mode: null,
          mental_model: null,
          personal_observation: null,
          claims: [{ claim: 'Rotation detects replay', status: 'supported', source_ids: [] }],
          angle_candidates: ['insight'],
        }),
      },
    });

    const { atom } = await shellFor(NOTE_FIXTURES[0]!.text);
    const result = await buildContentAtom(ctx, atom.id, { llm: liar });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.atom.body.claims[0]).toMatchObject({ status: 'needs_review' });
    expect(result.value.evidence_status).toBe('needs_review');
  });

  it('rejects a body that cites a source the atom does not have', async () => {
    const fabricator = createMockLlmAdapter({
      handlers: {
        'atom.v1': () => ({
          problem: 'Why does this matter?',
          core_insight: 'Something plausible about rotation and replay detection.',
          first_principles: 'Because a static credential is indistinguishable from a stolen one.',
          example: null,
          implementation_details: null,
          failure_mode: null,
          mental_model: null,
          personal_observation: null,
          claims: [
            { claim: 'Backed by the spec', status: 'supported', source_ids: ['sd_fabricated'] },
          ],
          angle_candidates: ['insight'],
        }),
      },
    });

    const { atom } = await shellFor(NOTE_FIXTURES[0]!.text);
    const result = await buildContentAtom(ctx, atom.id, { llm: fabricator });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_ATOM_INVALID_CITATION');

    const stored = await contentAtoms.findAtom(db.db, atom.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('sd_fabricated');
  });

  it('rejects an incomplete body instead of storing a half-built atom as ready', async () => {
    const lazy = createMockLlmAdapter({
      handlers: {
        'atom.v1': () => ({
          problem: 'Why?',
          core_insight: '',
          first_principles: '',
          example: null,
          implementation_details: null,
          failure_mode: null,
          mental_model: null,
          personal_observation: null,
          claims: [],
          angle_candidates: [],
        }),
      },
    });

    const { atom } = await shellFor(NOTE_FIXTURES[1]!.text);
    const result = await buildContentAtom(ctx, atom.id, { llm: lazy });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_ATOM_INCOMPLETE');

    const stored = await contentAtoms.findAtom(db.db, atom.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.body.core_insight).toBe(''); // the half-built body was never promoted
  });

  it('stores a failed transformation with its error state when the model is unreachable', async () => {
    const { atom } = await shellFor(NOTE_FIXTURES[2]!.text);
    const result = await buildContentAtom(ctx, atom.id, { llm: createFailingLlmAdapter() });

    expect(result.ok).toBe(false);
    const stored = await contentAtoms.findAtom(db.db, atom.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('E_LLM_UNREACHABLE');

    const errors = await operations.listErrorEvents(db.db, {});
    expect(errors.some((e) => e.workflow === 'atom_build_v1')).toBe(true);
  });

  it('recovers from a failed build and clears the error', async () => {
    const { atom } = await shellFor(NOTE_FIXTURES[2]!.text);
    await buildContentAtom(ctx, atom.id, { llm: createFailingLlmAdapter() });

    const recovered = await buildContentAtom(ctx, atom.id, { llm });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.atom.status).toBe('ready');
    expect(recovered.value.atom.error).toBeNull();
  });

  it('never upgrades synthetic evidence, however confident the model is', async () => {
    const { atom } = await shellFor(NOTE_FIXTURES[0]!.text);
    // Research with the mock provider leaves the atom at needs_review.
    await contentAtoms.updateAtom(db.db, atom.id, { evidence_status: 'needs_review' });

    const confident = createMockLlmAdapter({
      handlers: {
        'atom.v1': () => ({
          problem: 'Why does refresh-token rotation matter?',
          core_insight: 'Rotation makes a stolen token detectable when it is replayed.',
          first_principles: 'A static credential cannot be distinguished from a stolen copy of it.',
          example: null,
          implementation_details: null,
          failure_mode: null,
          mental_model: null,
          personal_observation: null,
          claims: [{ claim: 'Rotation detects replay', status: 'supported', source_ids: [] }],
          angle_candidates: ['insight'],
        }),
      },
    });

    const result = await buildContentAtom(ctx, atom.id, { llm: confident });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence_status).toBe('needs_review');
  });

  it('never claims evidence when research failed', async () => {
    const { atom } = await shellFor(NOTE_FIXTURES[0]!.text);
    await contentAtoms.updateAtom(db.db, atom.id, { evidence_status: 'research_failed' });

    const result = await buildContentAtom(ctx, atom.id, { llm });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence_status).toBe('research_failed');
  });

  it('extracts a failure mode from a note that describes a mistake', async () => {
    const { atom } = await shellFor(NOTE_FIXTURES[2]!.text); // the Redis lock mistake
    const result = await buildContentAtom(ctx, atom.id, { llm });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.atom.body.failure_mode).toBeTruthy();
    expect(result.value.atom.body.angle_candidates).toContain('failure_mode');
  });

  it('only records personal observation when the note actually contains one', async () => {
    const { atom: personal } = await shellFor(NOTE_FIXTURES[2]!.text); // "Mistake I made: ..."
    const withPersonal = await buildContentAtom(ctx, personal.id, { llm });
    expect(withPersonal.ok && withPersonal.value.atom.body.personal_observation).toBeTruthy();

    const impersonal = await shellFor(
      'Refresh token rotation invalidates the previous token on every refresh, which turns a replayed token into a detectable signal.',
    );
    const built = await buildContentAtom(ctx, impersonal.atom.id, { llm });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.atom.body.personal_observation).toBeNull();
  });

  it('fails clearly for an unknown atom', async () => {
    const result = await buildContentAtom(ctx, 'ca_missing', { llm });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_ATOM_NOT_FOUND');
  });
});
