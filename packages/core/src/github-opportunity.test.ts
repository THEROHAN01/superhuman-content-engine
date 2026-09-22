import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, hasTestDatabase, learningEvents, operations, type TestDb } from '@sce/db';
import { createMockLlmAdapter } from '@sce/adapters';
import { createLogger, fixedClock, parseEnv } from '@sce/utils';
import type { ServiceContext } from './context.js';
import { forceGithubOpportunity, ingestGithubEvent } from './github-opportunity.js';
import { processLearningEvent } from './process-learning.js';
import { GITHUB_FIXTURES } from '../../../tests/fixtures/github-events.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('github opportunities', () => {
  let db: TestDb;
  let ctx: ServiceContext;

  const fixture = (name: string) => {
    const found = GITHUB_FIXTURES.find((f) => f.name === name);
    if (!found) throw new Error(`no fixture named ${name}`);
    return found;
  };

  beforeAll(async () => {
    db = await createTestDb('github');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-22T12:00:00.000Z'),
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  for (const f of GITHUB_FIXTURES) {
    it(`fixture: ${f.name}`, async () => {
      const result = await ingestGithubEvent(ctx, { eventType: f.eventType, payload: f.payload });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.status, `${f.name}: ${result.value.reason}`).toBe(f.expect.status);
      if (f.expect.reasonMatches) {
        expect(result.value.reason).toMatch(f.expect.reasonMatches);
      }

      const { rows } = await db.db.query<{ count: number }>(
        'SELECT count(*)::int FROM learning_events',
      );
      expect(rows[0]!.count).toBe(f.expect.status === 'captured' ? 1 : 0);
    });
  }

  it('captures the GitHub link, repository and stats as provenance', async () => {
    const result = await ingestGithubEvent(ctx, {
      eventType: 'pull_request',
      payload: fixture('merged PR with a real explanation').payload,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.learning_event) return;

    const event = result.value.learning_event;
    expect(event.source).toBe('github');
    expect(event.external_id).toMatch(/^pr:/);
    expect(event.raw_text).toContain(
      'https://github.com/therohan01/superhuman-content-engine/pull/12',
    );
    expect(event.context['repository']).toBe('therohan01/superhuman-content-engine');
    expect(event.context['url']).toContain('/pull/12');
    expect(event.tags).toContain('github');
    expect(event.captured_at).toBe('2026-09-22T08:00:00.000Z'); // the merge time, not ingest time
  });

  it('does not duplicate an opportunity when the same event arrives twice', async () => {
    const payload = fixture('merged PR with a real explanation').payload;
    const first = await ingestGithubEvent(ctx, { eventType: 'pull_request', payload });
    const second = await ingestGithubEvent(ctx, { eventType: 'pull_request', payload });

    expect(first.ok && first.value.status).toBe('captured');
    expect(second.ok && second.value.status).toBe('duplicate');
    if (first.ok && second.ok) {
      expect(second.value.learning_event?.id).toBe(first.value.learning_event?.id);
    }

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('does not duplicate when the same PR is edited and redelivered', async () => {
    const base = fixture('merged PR with a real explanation').payload as Record<string, unknown>;
    const edited = {
      ...base,
      pull_request: {
        ...(base['pull_request'] as Record<string, unknown>),
        title: 'Claim the slot first (edited)',
      },
    };

    await ingestGithubEvent(ctx, { eventType: 'pull_request', payload: base });
    const second = await ingestGithubEvent(ctx, { eventType: 'pull_request', payload: edited });

    // Same PR id, so the same opportunity - even though the text changed.
    expect(second.ok && second.value.status).toBe('duplicate');
    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('forces a filtered event through when an operator insists', async () => {
    const payload = fixture('dependency bump').payload;
    const filtered = await ingestGithubEvent(ctx, { eventType: 'pull_request', payload });
    expect(filtered.ok && filtered.value.status).toBe('filtered');

    const forced = await forceGithubOpportunity(ctx, { eventType: 'pull_request', payload });
    expect(forced.ok && forced.value.status).toBe('captured');
    if (forced.ok && forced.value.learning_event) {
      const significance = forced.value.learning_event.context['significance'] as Record<
        string,
        unknown
      >;
      expect(significance['forced']).toBe(true);
    }
  });

  it('feeds the normal pipeline: a captured event classifies like any other learning', async () => {
    const captured = await ingestGithubEvent(ctx, {
      eventType: 'pull_request',
      payload: fixture('merged PR with a real explanation').payload,
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok || !captured.value.learning_event) return;

    const processed = await processLearningEvent(ctx, captured.value.learning_event.id, {
      llm: createMockLlmAdapter(),
    });
    expect(processed.ok).toBe(true);
    if (!processed.ok) return;
    expect(processed.value.event.status).toBe('atomized');
    expect(processed.value.atom).not.toBeNull();
  });

  it('records a workflow run for a captured event and none for a filtered one', async () => {
    await ingestGithubEvent(ctx, {
      eventType: 'pull_request',
      payload: fixture('merged PR with a real explanation').payload,
    });
    await ingestGithubEvent(ctx, {
      eventType: 'pull_request',
      payload: fixture('dependency bump').payload,
    });

    const runs = await operations.listWorkflowRuns(db.db, { workflow: 'github_opportunity_v1' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('succeeded');
  });

  it('stores nothing for an unparseable payload', async () => {
    const result = await ingestGithubEvent(ctx, {
      eventType: 'pull_request',
      payload: { nonsense: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('filtered');
    expect(result.value.reason).toMatch(/failed validation/);

    const events = await learningEvents.listLearningEvents(db.db, {});
    expect(events).toHaveLength(0);
  });
});
