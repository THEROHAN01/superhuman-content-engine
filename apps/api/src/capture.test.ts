import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/** `inject` is overloaded; naming the awaited response type keeps the assertions typed. */
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
import { createTestDb, hasTestDatabase, type TestDb } from '@sce/db';
import { createLogger, fixedClock, parseEnv, type Env } from '@sce/utils';
import { buildApp } from './app.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

const testEnv = (overrides: Record<string, string> = {}): Env =>
  parseEnv({
    DATABASE_URL: process.env['TEST_DATABASE_URL']!,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...overrides,
  } as NodeJS.ProcessEnv);

describeDb('capture API', () => {
  let ctx: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    ctx = await createTestDb('capture_api');
    app = await buildApp({
      db: ctx.db,
      env: testEnv(),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-21T12:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.truncate();
  });

  const capture = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/capture', payload, headers }) as Promise<InjectResponse>;

  it('creates exactly one learning event from a short note', async () => {
    const response = await capture({ text: 'Today I learned why refresh-token rotation matters.' });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toMatch(/^le_/);
    expect(body.duplicate).toBe(false);
    expect(body.message).toContain('Captured');

    const { rows } = await ctx.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('preserves the original text exactly', async () => {
    const text = 'Learned that `SKIP LOCKED` avoids the thundering herd on a job table.';
    const { id } = (await capture({ text })).json();

    const stored = await app.inject({ method: 'GET', url: `/learning-events/${id}` });
    expect(stored.json().raw_text).toBe(text);
  });

  it('is idempotent: a repeated capture returns the original event with 200', async () => {
    const text = 'Learned that partial unique indexes enforce one-active-row invariants.';
    const first = await capture({ text });
    const second = await capture({ text });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().id).toBe(first.json().id);

    const { rows } = await ctx.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('deduplicates a provider redelivery by external id', async () => {
    const shared = { source: 'telegram', external_id: 'msg-1001' };
    const first = await capture({ ...shared, text: 'First version of the note about WAL fsync.' });
    const second = await capture({
      ...shared,
      text: 'Edited text, same telegram message id though.',
    });

    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().duplicate).toBe(true);
  });

  it('rejects malformed payloads with a useful 422', async () => {
    const response = await capture({ text: 'too short' });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe('E_INVALID_CAPTURE');
    expect(JSON.stringify(body.error.details)).toContain('text');
    expect(body.correlation_id).toBeTruthy();
  });

  it('rejects an unknown capture source', async () => {
    const response = await capture({
      text: 'a perfectly valid learning note here',
      source: 'pigeon',
    });
    expect(response.statusCode).toBe(422);
  });

  it('returns a correlation id and honours a supplied one', async () => {
    const generated = await capture({ text: 'correlation id generation probe note here' });
    expect(generated.headers['x-correlation-id']).toBeTruthy();

    const supplied = await capture(
      { text: 'correlation id propagation probe note here' },
      { 'x-correlation-id': 'cor_from_n8n_123' },
    );
    expect(supplied.headers['x-correlation-id']).toBe('cor_from_n8n_123');
    expect(supplied.json().correlation_id).toBe('cor_from_n8n_123');

    const { rows } = await ctx.db.query<{ correlation_id: string }>(
      `SELECT correlation_id FROM learning_events WHERE correlation_id = 'cor_from_n8n_123'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('records a workflow run for every capture', async () => {
    await capture({ text: 'workflow run recording probe note for capture' });
    const { rows } = await ctx.db.query<{ workflow: string; status: string }>(
      `SELECT workflow, status FROM workflow_runs`,
    );
    expect(rows).toEqual([{ workflow: 'learning_capture_v1', status: 'succeeded' }]);
  });

  it('retrieves a stored event and 404s for an unknown one', async () => {
    const { id } = (await capture({ text: 'retrieval probe note about index-only scans' })).json();

    const found = await app.inject({ method: 'GET', url: `/learning-events/${id}` });
    expect(found.statusCode).toBe(200);
    expect(found.json().id).toBe(id);

    const missing = await app.inject({ method: 'GET', url: '/learning-events/le_nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('E_NOT_FOUND');
  });

  it('lists events and validates the status filter', async () => {
    await capture({ text: 'listing probe one about vacuum and bloat' });
    await capture({ text: 'listing probe two about checkpoint tuning' });

    const list = await app.inject({ method: 'GET', url: '/learning-events?limit=10' });
    expect(list.json().count).toBe(2);

    const bad = await app.inject({ method: 'GET', url: '/learning-events?status=banana' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('E_INVALID_STATUS');
  });

  it('reports health honestly', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database.ok).toBe(true);
    expect(ready.json().config.publish_mode).toBe('dry_run');
  });

  it('404s unknown routes with the standard error shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('E_NOT_FOUND');
  });
});

describeDb('capture API authentication', () => {
  let ctx: TestDb;
  let app: FastifyInstance;
  const token = 'test-capture-token-0123456789';

  beforeAll(async () => {
    ctx = await createTestDb('capture_auth');
    app = await buildApp({
      db: ctx.db,
      env: testEnv({ CAPTURE_API_TOKEN: token }),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-21T12:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.close();
  });

  it('rejects requests without a token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/capture',
      payload: { text: 'an authenticated capture attempt without a token' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('E_UNAUTHORIZED');
  });

  it('rejects a wrong token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/capture',
      payload: { text: 'an authenticated capture attempt with a bad token' },
      headers: { authorization: 'Bearer wrong-token-0123456789012' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the configured token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/capture',
      payload: { text: 'an authenticated capture attempt with the right token' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(201);
  });

  it('leaves health probes unauthenticated', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });
});
