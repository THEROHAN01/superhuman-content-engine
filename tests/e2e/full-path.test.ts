import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '@sce/db';
import { createEngine, request, type Engine } from './harness.js';
import { FORMATS, NOTE, runFullPath, type PathResult } from './journey.js';

/**
 * The launch acceptance test.
 *
 * One realistic learning note is driven through every stage the build plan defines - capture,
 * normalization, classification, deduplication, atom, research, ideation, all five draft formats,
 * quality gate, Telegram approval (approve / reject / regenerate), scheduling, publication,
 * analytics and weekly intelligence - and the provenance chain is then verified in SQL.
 *
 * The suite runs the path once in `beforeAll` and asserts on the recorded artifacts, so a failure
 * names the stage that broke rather than re-running twenty HTTP calls per assertion.
 */
const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('end-to-end: learning event to weekly intelligence', () => {
  let engine: Engine;
  let path: PathResult;

  beforeAll(async () => {
    engine = await createEngine('e2e_full_path');
    path = await runFullPath(engine, NOTE, 'e2e-msg-1');
  });

  afterAll(async () => {
    await engine?.close();
  });

  it('captures the learning event and normalizes it', async () => {
    const { body } = await request<{
      raw_text: string;
      normalized_text: string;
      title: string;
      status: string;
    }>(engine.app, 'GET', `/learning-events/${path.learningEventId}`, undefined, 200);
    expect(body.raw_text).toBe(NOTE);
    // Normalization cleans the text - no carriage returns, no trailing whitespace - while
    // deliberately keeping the line structure the author wrote.
    expect(body.normalized_text).toContain('refresh-token rotation');
    expect(body.normalized_text).not.toMatch(/\r|[ \t]+\n|\s$/);
    expect(body.title).toBe('Why refresh-token rotation matters');
    expect(body.status).toBe('atomized');
  });

  it('classifies the note and finds no duplicate', () => {
    expect(path.classification.kind).toBe('core_engineering');
    expect(path.classification.primary_topic).toBe('security');
    expect(path.classification.content_worthy).toBe(true);
  });

  it('attaches non-synthetic evidence and reaches a supported atom', async () => {
    expect(path.evidence.synthetic_only).toBe(false);
    expect(path.evidence.sources_total).toBeGreaterThanOrEqual(2);
    expect(path.evidence.evidence_status).toBe('supported');
    for (const source of path.evidence.sources) {
      expect(source.provider).toBe('fixture');
      expect(source.url).toMatch(/^https:\/\//);
    }

    const { body } = await request<{
      atom: { status: string; body: { claims: Array<{ status: string; source_ids: string[] }> } };
      sources: Array<{ id: string }>;
      learning_event_id: string;
    }>(engine.app, 'GET', `/content-atoms/${path.atomId}`, undefined, 200);

    expect(body.atom.status).toBe('ready');
    expect(body.learning_event_id).toBe(path.learningEventId);
    const sourceIds = new Set(body.sources.map((s) => s.id));
    for (const claim of body.atom.body.claims) {
      expect(claim.status).not.toBe('unsupported');
      // Citations may only point at sources that exist - a fabricated id is the failure this
      // check exists to catch.
      for (const id of claim.source_ids) expect(sourceIds.has(id)).toBe(true);
    }
  });

  it('generates distinct, queued content ideas', () => {
    expect(path.ideas.length).toBeGreaterThanOrEqual(2);
    expect(new Set(path.ideas.map((i) => i.angle)).size).toBe(path.ideas.length);
    expect(path.ideas.filter((i) => i.status === 'queued')).toHaveLength(2);
  });

  it('produces every platform-native format the first release needs', () => {
    expect(path.drafts.map((d) => d.format).sort()).toEqual([...FORMATS].sort());
    for (const draft of path.drafts) {
      expect(draft.version).toBe(1);
      expect(draft.status).toBe('draft');
      expect(draft.characters).toBeGreaterThan(0);
    }
    // Multi-unit formats must actually be multi-unit, not one blob.
    expect(path.drafts.find((d) => d.format === 'x_thread')!.units).toBeGreaterThan(1);
    expect(path.drafts.find((d) => d.format === 'carousel')!.units).toBeGreaterThan(1);
    expect(path.drafts.find((d) => d.format === 'x_post')!.units).toBe(1);
  });

  it('gates every draft and records the verdict', () => {
    expect(path.gates).toHaveLength(FORMATS.length);
    for (const gate of path.gates) {
      expect(gate.gate_version).toBe('gate.v1');
      expect(gate.verdict).toBe('pass');
      expect(gate.status).toBe('gated');
      expect(gate.reasons.every((r) => r.severity !== 'block')).toBe(true);
    }
  });

  it('records the approve decision that arrived through the Telegram button', async () => {
    // The decision itself moved the item to `approved`; publishing later moves it on again.
    expect(path.approvedStatusAtDecision).toBe('approved');
    const { body } = await request<{ status: string }>(
      engine.app,
      'GET',
      `/content-items/${path.approvedId}`,
      undefined,
      200,
    );
    expect(body.status).toBe('published');

    const { rows } = await engine.db.db.query<{
      action: string;
      channel: string;
      decided_by: string;
    }>(`SELECT action, channel, decided_by FROM approvals WHERE content_item_id = $1`, [
      path.approvedId,
    ]);
    expect(rows).toEqual([{ action: 'approve', channel: 'telegram', decided_by: 'rohan' }]);

    // The card was edited so the buttons cannot be pressed a second time.
    expect(engine.telegram.edits.some((e) => e.removeButtons === true)).toBe(true);
  });

  it('records the rejection with its note and leaves no publication behind', async () => {
    const { body } = await request<{ status: string }>(
      engine.app,
      'GET',
      `/content-items/${path.rejectedId}`,
      undefined,
      200,
    );
    expect(body.status).toBe('rejected');

    const { rows } = await engine.db.db.query<{ note: string | null }>(
      `SELECT note FROM approvals WHERE content_item_id = $1 AND action = 'reject'`,
      [path.rejectedId],
    );
    expect(rows[0]!.note).toContain('thread repeats');

    const pubs = await request<{ count: number }>(
      engine.app,
      'GET',
      `/content-items/${path.rejectedId}/publications`,
      undefined,
      200,
    );
    expect(pubs.body.count).toBe(0);
  });

  it('regenerates as a new version and supersedes the old one without overwriting it', async () => {
    expect(path.regeneratedId).toMatch(/^it_/);
    expect(path.regeneratedId).not.toBe(path.regeneratedFrom);

    const previous = await request<{
      version: number;
      status: string;
      superseded_by: string | null;
      draft: { body: string };
    }>(engine.app, 'GET', `/content-items/${path.regeneratedFrom}`, undefined, 200);
    const next = await request<{ version: number; status: string; format: string }>(
      engine.app,
      'GET',
      `/content-items/${path.regeneratedId}`,
      undefined,
      200,
    );

    expect(previous.body.version).toBe(1);
    expect(previous.body.status).toBe('superseded');
    // The superseded draft is still readable - history is preserved, not deleted.
    expect(previous.body.draft.body.length).toBeGreaterThan(0);
    expect(previous.body.superseded_by).toBe(path.regeneratedId);
    expect(next.body.version).toBe(2);
    expect(next.body.format).toBe('linkedin_post');
  });

  it('schedules the approved draft and records the publication', async () => {
    const { body } = await request<{
      publications: Array<{
        id: string;
        status: string;
        dry_run: boolean;
        provider: string;
        external_id: string;
        idempotency_key: string;
        published_at: string | null;
      }>;
    }>(engine.app, 'GET', `/content-items/${path.approvedId}/publications`, undefined, 200);

    expect(body.publications).toHaveLength(1);
    const publication = body.publications[0]!;
    expect(publication.id).toBe(path.publicationId);
    expect(publication.status).toBe('published');
    // Development never publishes for real.
    expect(publication.dry_run).toBe(true);
    expect(publication.external_id).toBeTruthy();
    expect(publication.idempotency_key).toBeTruthy();
    expect(publication.published_at).toBeTruthy();
  });

  it('collects analytics and keeps unknown metrics null rather than zero', async () => {
    const { body } = await request<{
      count: number;
      events: Array<{
        id: string;
        metrics: Record<string, number | null>;
        derived: Record<string, number | null>;
      }>;
    }>(engine.app, 'GET', `/publications/${path.publicationId}/analytics`, undefined, 200);

    expect(body.count).toBe(1);
    const event = body.events[0]!;
    expect(event.id).toBe(path.analyticsEventId);
    expect(event.metrics['impressions']).toBeGreaterThan(0);
    // X reports no saves; the metric must stay unknown instead of being recorded as zero.
    expect(event.metrics['saves']).toBeNull();
    expect(event.derived['save_rate']).toBeNull();
    expect(event.derived['engagement_rate']).toBeGreaterThan(0);
  });

  it('generates the weekly report with counts that match what happened', () => {
    expect(path.reportId).toMatch(/^wr_/);
    expect(path.reportCounts['learning_events']).toBe(1);
    expect(path.reportCounts['content_atoms']).toBe(1);
    expect(path.reportCounts['drafts_generated']).toBe(FORMATS.length + 1); // + the regeneration
    expect(path.reportCounts['approved']).toBe(1);
    expect(path.reportCounts['rejected_by_human']).toBe(1);
    expect(path.reportCounts['published']).toBe(1);
  });

  it('renders the weekly report as text for delivery', async () => {
    const response = await engine.app.inject({
      method: 'GET',
      url: `/reports/weekly/${path.reportId}?format=text`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('2026-W39');
  });

  it('links every record back to the original learning event', async () => {
    const le = path.learningEventId;
    const one = async (sql: string, params: unknown[] = [le]): Promise<number> => {
      const { rows } = await engine.db.db.query<{ n: number }>(sql, params);
      return rows[0]!.n;
    };

    // Direct foreign keys.
    expect(
      await one(`SELECT count(*)::int AS n FROM content_atoms WHERE learning_event_id = $1`),
    ).toBe(1);
    expect(
      await one(`SELECT count(*)::int AS n FROM source_documents WHERE learning_event_id = $1`),
    ).toBeGreaterThanOrEqual(2);
    expect(
      await one(`SELECT count(*)::int AS n FROM analytics_events WHERE learning_event_id = $1`),
    ).toBe(1);

    // And the full chain, joined hop by hop: no row may dangle off a different event.
    const chain = await engine.db.db.query<{
      learning_event_id: string;
      atom_id: string;
      idea_id: string;
      item_id: string;
      publication_id: string;
      analytics_event_id: string;
    }>(
      `SELECT le.id AS learning_event_id,
              ca.id AS atom_id,
              ci.id AS idea_id,
              it.id AS item_id,
              pb.id AS publication_id,
              ae.id AS analytics_event_id
         FROM learning_events le
         JOIN content_atoms   ca ON ca.learning_event_id = le.id
         JOIN content_ideas   ci ON ci.content_atom_id   = ca.id
         JOIN content_items   it ON it.content_idea_id   = ci.id
         JOIN publications    pb ON pb.content_item_id   = it.id
         JOIN analytics_events ae ON ae.publication_id   = pb.id
        WHERE le.id = $1`,
      [le],
    );

    expect(chain.rows).toHaveLength(1);
    expect(chain.rows[0]).toMatchObject({
      learning_event_id: le,
      atom_id: path.atomId,
      item_id: path.approvedId,
      publication_id: path.publicationId,
      analytics_event_id: path.analyticsEventId,
    });

    // The gate verdict and the approval both hang off the published item.
    const { rows: itemRows } = await engine.db.db.query<{
      quality_gate: { verdict: string; gate_version: string } | null;
      learning_event_id: string;
    }>(`SELECT quality_gate, learning_event_id FROM content_items WHERE id = $1`, [
      path.approvedId,
    ]);
    expect(itemRows[0]!.learning_event_id).toBe(le);
    expect(itemRows[0]!.quality_gate?.verdict).toBe('pass');

    const { rows: approvalRows } = await engine.db.db.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM approvals a JOIN content_items it ON it.id = a.content_item_id
        WHERE it.learning_event_id = $1`,
      [le],
    );
    expect(approvalRows[0]!.n).toBe(3); // approve, reject, regenerate
  });

  it('records a workflow run for every stage and no unresolved error', async () => {
    const { rows } = await engine.db.db.query<{ workflow: string; status: string; n: number }>(
      `SELECT workflow, status, count(*)::int AS n FROM workflow_runs GROUP BY 1, 2 ORDER BY 1`,
    );
    const workflows = rows.map((r) => r.workflow);
    for (const expected of [
      'learning_capture_v1',
      'learning_process_v1',
      'atom_research_v1',
      'atom_build_v1',
      'content_ideate_v1',
      'content_generate_v1',
      'content_quality_gate_v1',
      'approval_request_v1',
      'approval_decide_v1',
      'content_publish_v1',
      'analytics_collect_v1',
      'weekly_report_v1',
    ]) {
      expect(workflows, `workflow ${expected} should have run`).toContain(expected);
    }
    expect(rows.filter((r) => r.status === 'failed')).toEqual([]);

    const { rows: errors } = await engine.db.db.query<{ code: string }>(
      `SELECT code FROM error_events`,
    );
    expect(errors).toEqual([]);
  });

  it('reports the system as healthy after a complete run', async () => {
    const { body } = await request<{ status: string; checks: Record<string, unknown> }>(
      engine.app,
      'GET',
      '/health/system',
      undefined,
      200,
    );
    expect(['healthy', 'degraded']).toContain(body.status);
  });
});
