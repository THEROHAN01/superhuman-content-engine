import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, hasTestDatabase, type TestDb } from '@sce/db';
import { createLogger, fixedClock, parseEnv } from '@sce/utils';
import { buildApp } from './app.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

describeDb('internal operations endpoints', () => {
  let ctx: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    ctx = await createTestDb('internal_api');
    app = await buildApp({
      db: ctx.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      } as NodeJS.ProcessEnv),
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

  const report = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/internal/errors', payload }) as Promise<InjectResponse>;

  it('records a workflow failure reported by n8n', async () => {
    const response = await report({
      workflow: 'learning_capture_v1',
      step: 'POST /capture',
      kind: 'transient',
      code: 'E_N8N_EXECUTION_FAILED',
      message: 'connect ECONNREFUSED api:8080',
      correlation_id: 'cor_n8n_42',
      details: { execution_url: 'http://localhost:5678/execution/42' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().id).toMatch(/^ev_/);

    const { rows } = await ctx.db.query<{ workflow: string; code: string; correlation_id: string }>(
      'SELECT workflow, code, correlation_id FROM error_events',
    );
    expect(rows).toEqual([
      {
        workflow: 'learning_capture_v1',
        code: 'E_N8N_EXECUTION_FAILED',
        correlation_id: 'cor_n8n_42',
      },
    ]);
  });

  it('rejects an invalid error report rather than storing junk', async () => {
    const response = await report({ step: 'nowhere' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('E_INVALID_ERROR_REPORT');

    const { rows } = await ctx.db.query<{ count: number }>(
      'SELECT count(*)::int FROM error_events',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('lists errors filtered by correlation id', async () => {
    await report({ workflow: 'a_v1', message: 'first failure', correlation_id: 'cor_one' });
    await report({ workflow: 'b_v1', message: 'second failure', correlation_id: 'cor_two' });

    const all = await app.inject({ method: 'GET', url: '/internal/errors' });
    expect(all.json().count).toBe(2);

    const filtered = await app.inject({
      method: 'GET',
      url: '/internal/errors?correlation_id=cor_one',
    });
    expect(filtered.json().count).toBe(1);
    expect(filtered.json().events[0].workflow).toBe('a_v1');
  });

  it('exposes workflow runs for tracing a capture end to end', async () => {
    const capture = await app.inject({
      method: 'POST',
      url: '/capture',
      payload: { text: 'tracing probe: workflow runs should be queryable by correlation id' },
      headers: { 'x-correlation-id': 'cor_trace_1' },
    });
    expect(capture.statusCode).toBe(201);

    const runs = await app.inject({
      method: 'GET',
      url: '/internal/runs?correlation_id=cor_trace_1',
    });
    expect(runs.json().count).toBe(1);
    expect(runs.json().runs[0]).toMatchObject({
      workflow: 'learning_capture_v1',
      status: 'succeeded',
      correlation_id: 'cor_trace_1',
    });
  });
});
