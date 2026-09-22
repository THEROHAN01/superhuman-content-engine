import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, hasTestDatabase, type TestDb } from '@sce/db';
import {
  createFailingAnalyticsAdapter,
  createFailingLlmAdapter,
  createFailingPublishingAdapter,
  createFailingResearchAdapter,
} from '@sce/adapters';
import { createEngine, request, type Engine } from './harness.js';
import { NOTE } from './journey.js';

/**
 * Failure injection and recovery.
 *
 * Each external dependency is taken away in turn and the same two questions are asked:
 *   1. Did the system fail *visibly* - a typed error, a recorded `error_events` row, and a state
 *      that says "this did not happen" rather than a half-finished success?
 *   2. Does it recover when the dependency comes back, without duplicating anything?
 *
 * The recovery run rebuilds the app on the same schema with a working adapter, which is exactly
 * what restarting the API after an outage does.
 */
const describeDb = hasTestDatabase() ? describe : describe.skip;

const errorCodes = async (db: TestDb, code?: string): Promise<string[]> => {
  const { rows } = await db.db.query<{ code: string }>(
    code ? `SELECT code FROM error_events WHERE code = $1` : `SELECT code FROM error_events`,
    code ? [code] : [],
  );
  return rows.map((r) => r.code);
};

describeDb('failure injection: the model is unreachable', () => {
  let db: TestDb;
  let broken: Engine;
  let recovered: Engine;
  let learningEventId: string;

  beforeAll(async () => {
    db = await createTestDb('e2e_failure_llm');
    broken = await createEngine('unused', { db, llm: createFailingLlmAdapter() });
  });

  afterAll(async () => {
    await broken?.close();
    await recovered?.close();
    await db?.close();
  });

  it('still accepts the capture - intake does not depend on the model', async () => {
    const { status, body } = await request<{ id: string }>(
      broken.app,
      'POST',
      '/capture',
      { text: NOTE, source: 'manual', external_id: 'e2e-fail-1' },
      201,
    );
    expect(status).toBe(201);
    learningEventId = body.id;
  });

  it('fails the processing step loudly instead of inventing a classification', async () => {
    const { status, body } = await request<{ error: { code: string; message: string } }>(
      broken.app,
      'POST',
      `/learning-events/${learningEventId}/process`,
      {},
      503,
    );
    expect(status).toBe(503);
    expect(body.error.code).toBe('E_LLM_UNREACHABLE');
  });

  it('records the failure and leaves no half-built artifacts', async () => {
    expect(await errorCodes(db, 'E_LLM_UNREACHABLE')).toContain('E_LLM_UNREACHABLE');

    const { rows } = await db.db.query<{ status: string; classification: unknown }>(
      `SELECT status, classification FROM learning_events WHERE id = $1`,
      [learningEventId],
    );
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.classification).toBeNull();

    const atoms = await db.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_atoms WHERE learning_event_id = $1`,
      [learningEventId],
    );
    expect(atoms.rows[0]!.n).toBe(0);
  });

  it('surfaces the outage in system health', async () => {
    const { body } = await request<{
      status: string;
      recent_errors: Array<{ code: string; count: number }>;
    }>(broken.app, 'GET', '/health/system', undefined, 200);
    expect(body.recent_errors.map((e) => e.code)).toContain('E_LLM_UNREACHABLE');
  });

  it('recovers on a retry once the model is back, without duplicating anything', async () => {
    recovered = await createEngine('unused', { db });

    const { body } = await request<{ status: string; content_atom_id: string }>(
      recovered.app,
      'POST',
      `/learning-events/${learningEventId}/process`,
      {},
      200,
    );
    expect(body.status).toBe('atomized');
    expect(body.content_atom_id).toMatch(/^ca_/);

    const events = await db.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM learning_events`,
    );
    expect(events.rows[0]!.n).toBe(1);
    const atoms = await db.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM content_atoms`);
    expect(atoms.rows[0]!.n).toBe(1);

    // The failure is still on the record - recovery does not erase the incident.
    expect(await errorCodes(db, 'E_LLM_UNREACHABLE')).toHaveLength(1);
  });
});

describeDb('failure injection: research is unreachable', () => {
  let db: TestDb;
  let broken: Engine;
  let recovered: Engine;
  let atomId: string;

  beforeAll(async () => {
    db = await createTestDb('e2e_failure_research');
    broken = await createEngine('unused', { db, research: createFailingResearchAdapter() });

    const capture = await request<{ id: string }>(
      broken.app,
      'POST',
      '/capture',
      { text: NOTE, source: 'manual', external_id: 'e2e-fail-2' },
      201,
    );
    const processed = await request<{ content_atom_id: string }>(
      broken.app,
      'POST',
      `/learning-events/${capture.body.id}/process`,
      {},
      200,
    );
    atomId = processed.body.content_atom_id;
  });

  afterAll(async () => {
    await broken?.close();
    await recovered?.close();
    await db?.close();
  });

  it('never records a failed search as "found nothing"', async () => {
    const { body } = await request<{ evidence_status: string; sources_total: number }>(
      broken.app,
      'POST',
      `/content-atoms/${atomId}/research`,
      {},
      200,
    );
    expect(body.evidence_status).toBe('research_failed');
    expect(body.sources_total).toBe(0);
    expect(await errorCodes(db, 'E_RESEARCH_UNREACHABLE')).not.toHaveLength(0);
  });

  it('attaches real evidence once the provider is back', async () => {
    recovered = await createEngine('unused', { db });

    const { body } = await request<{
      evidence_status: string;
      sources_added: number;
      synthetic_only: boolean;
    }>(recovered.app, 'POST', `/content-atoms/${atomId}/research`, {}, 200);

    expect(body.evidence_status).toBe('supported');
    expect(body.sources_added).toBeGreaterThanOrEqual(2);
    expect(body.synthetic_only).toBe(false);

    const { body: built } = await request<{ status: string; unsupported_claims: number }>(
      recovered.app,
      'POST',
      `/content-atoms/${atomId}/build`,
      {},
      200,
    );
    expect(built.status).toBe('ready');
    expect(built.unsupported_claims).toBe(0);
  });
});

describeDb('failure injection: the publisher and the analytics provider are unreachable', () => {
  let db: TestDb;
  let engine: Engine;
  let brokenPublisher: Engine;
  let brokenAnalytics: Engine;
  let itemId: string;
  let publicationId: string;

  beforeAll(async () => {
    db = await createTestDb('e2e_failure_publish');
    engine = await createEngine('unused', { db });

    // Drive a draft as far as approved using the working stack.
    const capture = await request<{ id: string }>(
      engine.app,
      'POST',
      '/capture',
      { text: NOTE, source: 'manual', external_id: 'e2e-fail-3' },
      201,
    );
    const processed = await request<{ content_atom_id: string }>(
      engine.app,
      'POST',
      `/learning-events/${capture.body.id}/process`,
      {},
      200,
    );
    const atom = processed.body.content_atom_id;
    await request(engine.app, 'POST', `/content-atoms/${atom}/research`, {}, 200);
    await request(engine.app, 'POST', `/content-atoms/${atom}/build`, {}, 200);
    const ideas = await request<{ ideas: Array<{ id: string }> }>(
      engine.app,
      'POST',
      `/content-atoms/${atom}/ideas`,
      { queue: 1 },
      200,
    );
    const generated = await request<{ generated: Array<{ id: string }> }>(
      engine.app,
      'POST',
      `/content-ideas/${ideas.body.ideas[0]!.id}/generate`,
      { formats: ['x_post'] },
      200,
    );
    itemId = generated.body.generated[0]!.id;
    await request(engine.app, 'POST', `/content-items/${itemId}/gate`, {}, 200);
    await request(engine.app, 'POST', `/content-items/${itemId}/request-approval`, {}, 200);
    await request(
      engine.app,
      'POST',
      `/content-items/${itemId}/decide`,
      { action: 'approve', decided_by: 'rohan' },
      200,
    );
  });

  afterAll(async () => {
    await engine?.close();
    await brokenPublisher?.close();
    await brokenAnalytics?.close();
    await db?.close();
  });

  it('records a failed publication attempt rather than a phantom success', async () => {
    brokenPublisher = await createEngine('unused', {
      db,
      publisher: createFailingPublishingAdapter(),
    });

    const { status, body } = await request<{ error: { code: string } }>(
      brokenPublisher.app,
      'POST',
      `/content-items/${itemId}/schedule`,
      { scheduled_at: '2026-09-22T09:00:00.000Z' },
      503,
    );
    expect(status).toBe(503);
    expect(body.error.code).toBeTruthy();

    const { rows } = await db.db.query<{
      id: string;
      status: string;
      attempts: number;
      external_id: string | null;
    }>(`SELECT id, status, attempts, external_id FROM publications`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).not.toBe('published');
    expect(rows[0]!.external_id).toBeNull();
    expect(rows[0]!.attempts).toBeGreaterThanOrEqual(1);
    expect(await errorCodes(db)).not.toHaveLength(0);
  });

  it('publishes exactly once when the provider comes back', async () => {
    const { body } = await request<{ publication_id: string; status: string; dry_run: boolean }>(
      engine.app,
      'POST',
      `/content-items/${itemId}/schedule`,
      { scheduled_at: '2026-09-22T09:00:00.000Z' },
      [200, 201],
    );
    publicationId = body.publication_id;
    expect(body.status).toBe('scheduled');
    expect(body.dry_run).toBe(true);

    const { rows } = await db.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM publications`,
    );
    expect(rows[0]!.n).toBe(1);

    await request(engine.app, 'POST', `/publications/${publicationId}/mark-published`, {}, 200);
  });

  it('leaves metrics unknown when the analytics provider is down', async () => {
    brokenAnalytics = await createEngine('unused', {
      db,
      analytics: createFailingAnalyticsAdapter(),
    });

    const { status } = await request(
      brokenAnalytics.app,
      'POST',
      `/publications/${publicationId}/collect-analytics`,
      { window: '24h' },
      503,
    );
    expect(status).toBe(503);

    const { rows } = await db.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM analytics_events`,
    );
    // No row at all beats a row of zeroes: unknown is not zero.
    expect(rows[0]!.n).toBe(0);
  });

  it('collects the metrics once the provider is back', async () => {
    const { body } = await request<{ inserted: boolean; metrics: Record<string, number | null> }>(
      engine.app,
      'POST',
      `/publications/${publicationId}/collect-analytics`,
      { window: '24h' },
      [200, 201],
    );
    expect(body.inserted).toBe(true);
    expect(body.metrics['impressions']).toBeGreaterThan(0);

    const { rows } = await db.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM analytics_events`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('reports the incident history without hiding it', async () => {
    const codes = await errorCodes(db);
    expect(codes.length).toBeGreaterThanOrEqual(2);

    const { body } = await request<{ status: string }>(
      engine.app,
      'GET',
      '/health/system',
      undefined,
      200,
    );
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
  });
});
