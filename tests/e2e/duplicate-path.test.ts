import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '@sce/db';
import { createEngine, request, type Engine } from './harness.js';
import { FORMATS, NOTE, runFullPath, type PathResult } from './journey.js';

/**
 * Replay safety for the whole system.
 *
 * n8n retries, Telegram redelivers, an operator presses the button twice, a cron job overlaps
 * itself. So the complete documented path is executed a second time with identical inputs and the
 * database is asked the only question that matters: did anything happen twice?
 */
const describeDb = hasTestDatabase() ? describe : describe.skip;

const countOf = async (engine: Engine, table: string): Promise<number> => {
  const { rows } = await engine.db.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return rows[0]!.n;
};

const snapshot = async (engine: Engine): Promise<Record<string, number>> => {
  const tables = [
    'learning_events',
    'content_atoms',
    'source_documents',
    'content_ideas',
    'content_items',
    'approvals',
    'publications',
    'analytics_events',
    'weekly_reports',
  ];
  const out: Record<string, number> = {};
  for (const table of tables) out[table] = await countOf(engine, table);
  return out;
};

describeDb('end-to-end: duplicate execution of the complete path', () => {
  let engine: Engine;
  let first: PathResult;
  let second: PathResult;
  let afterFirst: Record<string, number>;
  let afterSecond: Record<string, number>;

  beforeAll(async () => {
    engine = await createEngine('e2e_duplicate_path');
    first = await runFullPath(engine, NOTE, 'e2e-dup-msg-1');
    afterFirst = await snapshot(engine);

    // Identical inputs, identical external id, and no new human decision: exactly what a retried
    // workflow delivers.
    second = await runFullPath(engine, NOTE, 'e2e-dup-msg-1', { regenerate: false });
    afterSecond = await snapshot(engine);
  });

  afterAll(async () => {
    await engine?.close();
  });

  it('resolves the replayed capture to the original learning event', () => {
    expect(second.learningEventId).toBe(first.learningEventId);
    expect(afterSecond['learning_events']).toBe(1);
  });

  it('reuses the same atom, sources and ideas rather than duplicating them', () => {
    expect(second.atomId).toBe(first.atomId);
    expect(afterSecond['content_atoms']).toBe(1);
    expect(afterSecond['source_documents']).toBe(afterFirst['source_documents']);
    expect(afterSecond['content_ideas']).toBe(afterFirst['content_ideas']);
    // The second research pass must add nothing: sources deduplicate on canonical URL.
    expect(second.evidence.sources_total).toBe(first.evidence.sources_total);
  });

  it('does not generate a single draft twice', () => {
    // Five formats plus the one regeneration the first pass asked for. The replay adds nothing.
    expect(afterFirst['content_items']).toBe(FORMATS.length + 1);
    expect(afterSecond['content_items']).toBe(FORMATS.length + 1);

    // Every format the replay did not touch resolves to the very same draft row.
    const untouched = (result: PathResult): string[] =>
      result.drafts
        .filter((d) => d.format !== 'linkedin_post')
        .map((d) => d.id)
        .sort();
    expect(untouched(second)).toEqual(untouched(first));

    // LinkedIn is the one the human regenerated in the first pass, so the live draft is now that
    // version 2 - not a sixth generation produced by the replay.
    const linkedin = second.drafts.find((d) => d.format === 'linkedin_post')!;
    expect(linkedin.id).toBe(first.regeneratedId);
    expect(linkedin.version).toBe(2);
  });

  it('returns the stored gate verdict instead of re-judging', () => {
    for (const gate of second.gates) {
      expect(gate.verdict).toBe('pass');
      expect(gate.gate_version).toBe('gate.v1');
    }
    const firstScores = first.gates.map((g) => g.score);
    expect(second.gates.map((g) => g.score)).toEqual(firstScores);
  });

  it('records each approval decision exactly once', async () => {
    const { rows } = await engine.db.db.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM approvals GROUP BY action ORDER BY action`,
    );
    // approve + reject once each; regenerate is a deliberate human action taken in both runs.
    expect(rows.find((r) => r.action === 'approve')!.n).toBe(1);
    expect(rows.find((r) => r.action === 'reject')!.n).toBe(1);
  });

  it('never publishes twice', () => {
    expect(first.scheduleStatus).toBe(201);
    // The replay is refused outright rather than queueing a second slot.
    expect(second.scheduleStatus).toBe(422);
    expect(second.publicationId).toBe(first.publicationId);
    expect(afterFirst['publications']).toBe(1);
    expect(afterSecond['publications']).toBe(1);
  });

  it('keeps one analytics row per publication, window and day', () => {
    expect(second.analyticsEventId).toBe(first.analyticsEventId);
    expect(afterSecond['analytics_events']).toBe(1);
  });

  it('refreshes the weekly report in place rather than creating a near-duplicate', () => {
    expect(second.reportId).toBe(first.reportId);
    expect(afterSecond['weekly_reports']).toBe(1);
  });

  it('leaves no external side effect behind on the replay', async () => {
    // The mock publisher records every call it was actually asked to make. Scheduling an already
    // scheduled slot must not reach the provider at all.
    const { rows } = await engine.db.db.query<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM publications`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.status).toBe('published');
  });

  it('recorded the replayed Telegram callback as a delivery without applying it twice', async () => {
    const { rows } = await engine.db.db.query<{ provider: string; n: number }>(
      `SELECT provider, count(*)::int AS n FROM webhook_deliveries GROUP BY provider`,
    );
    expect(rows).toEqual([{ provider: 'telegram', n: 2 }]);

    // Two deliveries, one decision.
    const approvals = await engine.db.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approvals WHERE action = 'approve'`,
    );
    expect(approvals.rows[0]!.n).toBe(1);
  });

  it('still answers reads consistently after the replay', async () => {
    const { body } = await request<{ count: number }>(
      engine.app,
      'GET',
      `/content-items/${first.approvedId}/publications`,
      undefined,
      200,
    );
    expect(body.count).toBe(1);
  });
});
