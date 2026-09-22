import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, hasTestDatabase, type TestDb } from '@sce/db';
import { signGithubPayload } from '@sce/adapters';
import { createLogger, fixedClock, parseEnv } from '@sce/utils';
import { buildApp } from './app.js';
import { GITHUB_FIXTURES } from '../../../tests/fixtures/github-events.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const SECRET = 'github-webhook-secret-0123456789';

describeDb('github webhook', () => {
  let db: TestDb;
  let app: FastifyInstance;

  const merged = GITHUB_FIXTURES.find((f) => f.name === 'merged PR with a real explanation')!;

  const deliver = (options: {
    payload: unknown;
    eventType?: string;
    deliveryId?: string;
    signature?: string;
  }) => {
    const body = JSON.stringify(options.payload);
    return app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': options.eventType ?? 'pull_request',
        'x-github-delivery': options.deliveryId ?? 'delivery-1',
        'x-hub-signature-256': options.signature ?? signGithubPayload(body, SECRET),
      },
      payload: body,
    }) as Promise<InjectResponse>;
  };

  beforeAll(async () => {
    db = await createTestDb('github_api');
    app = await buildApp({
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        GITHUB_WEBHOOK_SECRET: SECRET,
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-22T12:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  it('accepts a correctly signed delivery and creates an opportunity', async () => {
    const response = await deliver({ payload: merged.payload });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'captured' });
    expect(response.json().learning_event_id).toMatch(/^le_/);
  });

  it('rejects a delivery with no signature', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd',
      },
      payload: JSON.stringify(merged.payload),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain('missing');
  });

  it('rejects a delivery whose signature does not match the body', async () => {
    const response = await deliver({
      payload: merged.payload,
      signature: signGithubPayload('{"tampered":true}', SECRET),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('E_BAD_SIGNATURE');

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const body = JSON.stringify(merged.payload);
    const response = await deliver({
      payload: merged.payload,
      signature: signGithubPayload(body, 'another-secret'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed signature header', async () => {
    const response = await deliver({ payload: merged.payload, signature: 'sha1=deadbeef' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain('malformed');
  });

  it('requires the github event and delivery headers', async () => {
    const body = JSON.stringify(merged.payload);
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signGithubPayload(body, SECRET),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('E_MISSING_HEADERS');
  });

  it('recognises a redelivered webhook instead of processing it again', async () => {
    const first = await deliver({ payload: merged.payload, deliveryId: 'delivery-42' });
    const replay = await deliver({ payload: merged.payload, deliveryId: 'delivery-42' });

    expect(first.json().status).toBe('captured');
    expect(replay.json().status).toBe('duplicate_delivery');

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(1);

    const deliveries = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM webhook_deliveries',
    );
    expect(deliveries.rows[0]!.count).toBe(1);
  });

  it('deduplicates the same PR arriving under a different delivery id', async () => {
    await deliver({ payload: merged.payload, deliveryId: 'delivery-a' });
    const second = await deliver({ payload: merged.payload, deliveryId: 'delivery-b' });

    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('duplicate');

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('records a filtered trivial change without creating an opportunity', async () => {
    const trivial = GITHUB_FIXTURES.find((f) => f.name === 'dependency bump')!;
    const response = await deliver({ payload: trivial.payload, deliveryId: 'delivery-trivial' });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('filtered');
    expect(response.json().reason).toMatch(/routine maintenance/);

    const { rows } = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM learning_events',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('lets an operator force a filtered event through', async () => {
    const trivial = GITHUB_FIXTURES.find((f) => f.name === 'dependency bump')!;
    await deliver({ payload: trivial.payload, deliveryId: 'delivery-trivial-2' });

    const forced = await app.inject({
      method: 'POST',
      url: '/github/opportunities/force',
      payload: { event_type: 'pull_request', payload: trivial.payload },
    });

    expect(forced.statusCode).toBe(200);
    expect(forced.json().status).toBe('captured');
  });

  it('rejects a force request without a payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/github/opportunities/force',
      payload: { event_type: 'pull_request' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('E_INVALID_REQUEST');
  });
});

describeDb('github webhook without a configured secret', () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDb('github_api_nosecret');
    app = await buildApp({
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-22T12:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it('refuses to accept unauthenticated events rather than trusting them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd',
      },
      payload: { action: 'closed' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('E_WEBHOOK_DISABLED');
  });
});
