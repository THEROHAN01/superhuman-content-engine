import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentAtoms,
  contentIdeas,
  contentItems,
  createTestDb,
  hasTestDatabase,
  learningEvents,
  operations,
  sourceDocuments,
  type TestDb,
} from '@sce/db';
import { createMockLlmAdapter } from '@sce/adapters';
import {
  contentHash,
  createLogger,
  fixedClock,
  newCorrelationId,
  newId,
  parseEnv,
} from '@sce/utils';
import type { ContentDraft, EvidenceStatus } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import { GATE_VERSION, runQualityGate } from './quality-gate.js';
import { DRAFT_FIXTURES } from '../../../tests/fixtures/drafts.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('quality gate', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const llm = createMockLlmAdapter();

  /** Builds an item with the exact surrounding state a fixture describes. */
  const itemWith = async (
    draft: ContentDraft,
    context: {
      evidenceRequired?: boolean;
      evidenceStatus?: string;
      claims?: Array<{ claim: string; status: 'supported' | 'needs_review' | 'unsupported' }>;
      personalObservation?: string | null;
      sourceProvider?: string;
      withSource?: boolean;
    } = {},
  ) => {
    const text = `note ${newId('learningEvent')} about refresh token rotation and replay detection`;
    const { event } = await learningEvents.insertLearningEvent(db.db, {
      id: newId('learningEvent'),
      source: 'http',
      external_id: null,
      raw_text: text,
      title: 'Refresh token rotation',
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
      title: 'Refresh token rotation',
      kind: 'core_engineering',
      primary_topic: 'security',
      secondary_topics: [],
      entities: ['JWT'],
      body: {
        problem: 'Why rotate refresh tokens?',
        core_insight: 'Rotation makes a replayed token detectable.',
        first_principles: 'A static credential cannot be distinguished from a stolen copy.',
        example: null,
        implementation_details: null,
        failure_mode: null,
        mental_model: null,
        personal_observation:
          context.personalObservation === undefined ? null : context.personalObservation,
        claims: (context.claims ?? [{ claim: 'Rotation detects replay', status: 'supported' }]).map(
          (c) => ({
            ...c,
            source_ids: [],
          }),
        ),
        angle_candidates: ['insight'],
      },
      evidence_status: (context.evidenceStatus ?? 'supported') as EvidenceStatus,
      confidence: 0.8,
      generator_version: 'atom.v1',
    });

    if (context.withSource !== false) {
      await sourceDocuments.insertSourceDocument(db.db, {
        id: newId('sourceDocument'),
        learning_event_id: event.id,
        content_atom_id: atom.id,
        title: 'OAuth 2.0 spec',
        url: 'https://rfc-editor.org/rfc/rfc6749',
        canonical_url: 'https://rfc-editor.org/rfc/rfc6749',
        source_type: 'rfc',
        excerpt: 'Refresh tokens are credentials used to obtain access tokens.',
        summary: null,
        provider: context.sourceProvider ?? 'scripted',
        relevance: 0.9,
      });
    }

    const { idea } = await contentIdeas.insertContentIdea(db.db, {
      id: newId('contentIdea'),
      content_atom_id: atom.id,
      learning_event_id: event.id,
      status: 'queued',
      angle: 'insight',
      title: 'Why rotation detects replay',
      rationale: 'Explains the mechanism directly.',
      audience: 'backend engineers',
      platforms: ['x'],
      formats: ['x_post'],
      hook: 'A stolen refresh token looks like a legitimate one.',
      evidence_required: context.evidenceRequired ?? true,
      dedupe_hash: contentHash(newId('contentIdea')),
      rejection_reason: null,
      score: 0.7,
      prompt_version: 'ideation.v1',
    });

    const { item } = await contentItems.insertContentItemVersion(db.db, {
      id: newId('contentItem'),
      content_idea_id: idea.id,
      content_atom_id: atom.id,
      learning_event_id: event.id,
      platform: 'x',
      format: 'x_post',
      draft,
      prompt_id: 'x_post',
      prompt_version: 'x-post.v1',
      model: 'mock',
      correlation_id: event.correlation_id,
    });

    return { item, idea, atom, event };
  };

  beforeAll(async () => {
    db = await createTestDb('quality_gate');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-21T12:00:00.000Z'),
    };
    void llm;
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  for (const fixture of DRAFT_FIXTURES) {
    it(`fixture: ${fixture.name}`, async () => {
      const { item } = await itemWith(fixture.draft, fixture.context ?? {});
      const result = await runQualityGate(ctx, item.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const codes = result.value.result.reasons.map((r) => r.code);
      expect(result.value.result.verdict, `${fixture.name} -> ${codes.join(', ')}`).toBe(
        fixture.expect.verdict,
      );
      if (fixture.expect.reason) {
        expect(codes, fixture.name).toContain(fixture.expect.reason);
      }
    });
  }

  it('stores the gate version and timestamp with the result', async () => {
    const { item } = await itemWith(DRAFT_FIXTURES[0]!.draft, DRAFT_FIXTURES[0]!.context ?? {});
    const result = await runQualityGate(ctx, item.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.result.gate_version).toBe(GATE_VERSION);
    expect(result.value.result.evaluated_at).toBe('2026-09-21T12:00:00.000Z');

    const stored = await contentItems.findContentItem(db.db, item.id);
    expect(stored?.quality_gate?.gate_version).toBe(GATE_VERSION);
  });

  it('moves a passing item to gated and a rejected one to rejected', async () => {
    const pass = await itemWith(DRAFT_FIXTURES[0]!.draft, DRAFT_FIXTURES[0]!.context ?? {});
    const passResult = await runQualityGate(ctx, pass.item.id);
    expect(passResult.ok && passResult.value.item.status).toBe('gated');

    const reject = await itemWith(DRAFT_FIXTURES[1]!.draft, DRAFT_FIXTURES[1]!.context ?? {});
    const rejectResult = await runQualityGate(ctx, reject.item.id);
    expect(rejectResult.ok && rejectResult.value.item.status).toBe('rejected');
  });

  it('is idempotent: a replay returns the stored verdict without re-evaluating', async () => {
    const { item } = await itemWith(DRAFT_FIXTURES[0]!.draft, DRAFT_FIXTURES[0]!.context ?? {});
    const first = await runQualityGate(ctx, item.id);
    const second = await runQualityGate(ctx, item.id);
    const third = await runQualityGate(ctx, item.id);

    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    expect(second.value.unchanged).toBe(true);
    expect(third.value.unchanged).toBe(true);
    expect(second.value.result).toEqual(first.value.result);

    const runs = await operations.listWorkflowRuns(db.db, { workflow: 'content_quality_gate_v1' });
    expect(runs).toHaveLength(1); // replays do no work
  });

  it('is deterministic: forcing a re-evaluation reproduces the result exactly', async () => {
    const { item } = await itemWith(DRAFT_FIXTURES[4]!.draft, DRAFT_FIXTURES[4]!.context ?? {});

    const first = await runQualityGate(ctx, item.id);
    const second = await runQualityGate(ctx, item.id, { force: true });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value.unchanged).toBe(false);
    expect(second.value.result.verdict).toBe(first.value.result.verdict);
    expect(second.value.result.score).toBe(first.value.result.score);
    expect(second.value.result.reasons).toEqual(first.value.result.reasons);
  });

  it('does not count a rejected draft as existing content', async () => {
    // Fixture 4 is rejected by the gate. A later draft that resembles it must not be blocked for
    // repeating something that will never be published.
    const rejected = await itemWith(DRAFT_FIXTURES[4]!.draft, DRAFT_FIXTURES[4]!.context ?? {});
    const first = await runQualityGate(ctx, rejected.item.id);
    expect(first.ok && first.value.result.verdict).toBe('reject');

    const twin = await itemWith(DRAFT_FIXTURES[4]!.draft, DRAFT_FIXTURES[4]!.context ?? {});
    const second = await runQualityGate(ctx, twin.item.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.result.reasons.map((r) => r.code)).not.toContain(
      'REPEATS_EXISTING_CONTENT',
    );
  });

  it('never alters the draft it judges', async () => {
    const { item } = await itemWith(DRAFT_FIXTURES[4]!.draft, DRAFT_FIXTURES[4]!.context ?? {});
    const before = JSON.stringify(item.draft);
    await runQualityGate(ctx, item.id);

    const after = await contentItems.findContentItem(db.db, item.id);
    expect(JSON.stringify(after?.draft)).toBe(before);
  });

  it('blocks content built on synthetic evidence', async () => {
    const { item } = await itemWith(DRAFT_FIXTURES[0]!.draft, {
      ...DRAFT_FIXTURES[0]!.context,
      sourceProvider: 'mock',
    });
    const result = await runQualityGate(ctx, item.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.verdict).toBe('reject');
    expect(result.value.result.reasons.map((r) => r.code)).toContain('SYNTHETIC_EVIDENCE');
  });

  it('blocks a draft that repeats existing content', async () => {
    const first = await itemWith(DRAFT_FIXTURES[0]!.draft, DRAFT_FIXTURES[0]!.context ?? {});
    await runQualityGate(ctx, first.item.id);

    const copy = await itemWith(DRAFT_FIXTURES[0]!.draft, DRAFT_FIXTURES[0]!.context ?? {});
    const result = await runQualityGate(ctx, copy.item.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.reasons.map((r) => r.code)).toContain('REPEATS_EXISTING_CONTENT');
    expect(result.value.result.verdict).toBe('reject');
  });

  it('gives every reason a machine-readable code and a human-readable detail', async () => {
    const { item } = await itemWith(DRAFT_FIXTURES[4]!.draft, DRAFT_FIXTURES[4]!.context ?? {});
    const result = await runQualityGate(ctx, item.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const reason of result.value.result.reasons) {
      expect(reason.code).toMatch(/^[A-Z][A-Z_]+$/);
      expect(['info', 'warn', 'block']).toContain(reason.severity);
      expect(reason.detail.length).toBeGreaterThan(5);
    }
  });

  it('fails clearly for an unknown item', async () => {
    const result = await runQualityGate(ctx, 'it_missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_ITEM_NOT_FOUND');
  });
});
