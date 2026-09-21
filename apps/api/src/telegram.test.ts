import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  approvals as approvalsRepo,
  contentAtoms,
  contentIdeas,
  contentItems,
  createTestDb,
  hasTestDatabase,
  learningEvents,
  sourceDocuments,
  type TestDb,
} from '@sce/db';
import {
  createMockLlmAdapter,
  createMockTelegramAdapter,
  type MockTelegramAdapter,
} from '@sce/adapters';
import { encodeCallbackData, runQualityGate } from '@sce/core';
import {
  contentHash,
  createLogger,
  fixedClock,
  newCorrelationId,
  newId,
  parseEnv,
} from '@sce/utils';
import { buildApp } from './app.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const SECRET = 'telegram-webhook-secret-01234';

describeDb('telegram approval webhook', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let telegram: MockTelegramAdapter;

  const seedGatedItem = async () => {
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
        personal_observation: null,
        claims: [{ claim: 'Rotation detects replay', status: 'supported', source_ids: [] }],
        angle_candidates: ['insight'],
      },
      evidence_status: 'supported',
      confidence: 0.8,
      generator_version: 'atom.v1',
    });
    await sourceDocuments.insertSourceDocument(db.db, {
      id: newId('sourceDocument'),
      learning_event_id: event.id,
      content_atom_id: atom.id,
      title: 'OAuth 2.0',
      url: 'https://rfc-editor.org/rfc/rfc6749',
      canonical_url: 'https://rfc-editor.org/rfc/rfc6749',
      source_type: 'rfc',
      excerpt: 'Refresh tokens are credentials used to obtain access tokens.',
      summary: null,
      provider: 'scripted',
      relevance: 0.9,
    });
    const { idea } = await contentIdeas.insertContentIdea(db.db, {
      id: newId('contentIdea'),
      content_atom_id: atom.id,
      learning_event_id: event.id,
      status: 'queued',
      angle: 'insight',
      title: 'Why rotation detects replay',
      rationale: 'Explains the mechanism.',
      audience: 'backend engineers',
      platforms: ['x'],
      formats: ['x_post'],
      hook: 'A stolen refresh token looks like a legitimate one.',
      evidence_required: true,
      dedupe_hash: contentHash(newId('contentIdea')),
      rejection_reason: null,
      score: 0.7,
      prompt_version: 'ideation.v1',
    });
    const body =
      'A stolen refresh token looks exactly like a legitimate one, because both present the same credential. Rotation invalidates the previous token, so a replayed JWT is proof of theft.';
    const { item } = await contentItems.insertContentItemVersion(db.db, {
      id: newId('contentItem'),
      content_idea_id: idea.id,
      content_atom_id: atom.id,
      learning_event_id: event.id,
      platform: 'x',
      format: 'x_post',
      draft: {
        hook: 'A stolen refresh token looks exactly like a legitimate one.',
        units: [{ index: 0, text: body, note: null }],
        body,
        hashtags: [],
        call_to_action: null,
        source_attributions: [],
      },
      prompt_id: 'x_post',
      prompt_version: 'x-post.v1',
      model: 'mock',
      correlation_id: event.correlation_id,
    });

    const ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ name: 'test', level: 'silent' }),
      clock: fixedClock('2026-09-21T12:00:00.000Z'),
    };
    const gate = await runQualityGate(ctx, item.id);
    if (!gate.ok) throw new Error('setup: gate failed');
    return gate.value.item;
  };

  const callback = (payload: { updateId: number; data: string; callbackId: string }) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: {
        update_id: payload.updateId,
        callback_query: {
          id: payload.callbackId,
          from: { id: 42, username: 'rohan' },
          message: { message_id: 7, chat: { id: 123 } },
          data: payload.data,
        },
      },
    }) as Promise<InjectResponse>;

  beforeAll(async () => {
    db = await createTestDb('telegram_api');
    telegram = createMockTelegramAdapter();
    app = await buildApp(
      {
        db: db.db,
        env: parseEnv({
          DATABASE_URL: process.env['TEST_DATABASE_URL']!,
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          TELEGRAM_WEBHOOK_SECRET: SECRET,
          TELEGRAM_CHAT_ID: '123',
        } as NodeJS.ProcessEnv),
        logger: createLogger({ name: 'test', level: 'silent' }),
        clock: fixedClock('2026-09-21T12:00:00.000Z'),
      },
      { telegram, llm: createMockLlmAdapter() },
    );
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
    telegram.reset();
  });

  it('rejects an update without the secret token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/telegram',
      payload: { update_id: 1 },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('E_UNAUTHORIZED');
  });

  it('rejects an update with the wrong secret token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret-value-0123456789' },
      payload: { update_id: 1 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('acknowledges a non-decision update without doing anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: { update_id: 2, message: { message_id: 1, chat: { id: 123 }, text: 'hello' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ignored).toBeTruthy();
  });

  it('applies an approval from a button press, answers the callback and edits the card', async () => {
    const item = await seedGatedItem();
    await app.inject({
      method: 'POST',
      url: `/content-items/${item.id}/request-approval`,
      payload: { chat_id: '123' },
    });

    const response = await callback({
      updateId: 10,
      data: encodeCallbackData(item.id, item.version, 'approve'),
      callbackId: 'cbq-10',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ action: 'approve', applied: true, status: 'approved' });
    expect(telegram.acks.map((a) => a.callbackQueryId)).toContain('cbq-10');
    expect(telegram.edits[0]?.removeButtons).toBe(true);
    expect(telegram.edits[0]?.text).toContain('approve');
  });

  it('a redelivered update does not apply the decision twice', async () => {
    const item = await seedGatedItem();
    await app.inject({
      method: 'POST',
      url: `/content-items/${item.id}/request-approval`,
      payload: { chat_id: '123' },
    });

    const data = encodeCallbackData(item.id, item.version, 'approve');
    const first = await callback({ updateId: 11, data, callbackId: 'cbq-11' });
    const replay = await callback({ updateId: 11, data, callbackId: 'cbq-11' });

    expect(first.json().applied).toBe(true);
    expect(replay.json().applied).toBe(false);

    const stored = await approvalsRepo.listApprovalsForItem(db.db, item.id);
    expect(stored).toHaveLength(1);

    const deliveries = await db.db.query<{ count: number }>(
      'SELECT count(*)::int FROM webhook_deliveries',
    );
    expect(deliveries.rows[0]!.count).toBe(1); // the redelivery was recognised, not recorded twice
  });

  it('answers an unrecognised button without changing anything', async () => {
    const response = await callback({
      updateId: 12,
      data: 'sce:zz:it_nope:1',
      callbackId: 'cbq-12',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ignored).toBeTruthy();
    expect(telegram.acks[0]?.text).toContain('not recognised');
  });

  it('answers an expired action id with an explanation rather than a failure', async () => {
    const response = await callback({
      updateId: 13,
      data: 'sce:ap:it_0000000000000000000000000:1',
      callbackId: 'cbq-13',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().error).toBe('E_ITEM_NOT_FOUND');
    expect(telegram.acks[0]?.text).toContain('out of date');
  });

  it('supports deciding through the API when the bot is unavailable', async () => {
    const item = await seedGatedItem();
    await app.inject({
      method: 'POST',
      url: `/content-items/${item.id}/request-approval`,
      payload: { chat_id: '123' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/content-items/${item.id}/decide`,
      payload: { action: 'approve', decided_by: 'operator' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'approved', applied: true });
  });

  it('refuses an invalid decision payload', async () => {
    const item = await seedGatedItem();
    const response = await app.inject({
      method: 'POST',
      url: `/content-items/${item.id}/decide`,
      payload: { action: 'delete-everything' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('E_INVALID_DECISION');
  });

  it('only approved content can leave the approval stage', async () => {
    const item = await seedGatedItem();
    const before = await contentItems.findContentItem(db.db, item.id);
    expect(before?.status).toBe('gated');

    // Without an approval, the item never reaches 'approved'.
    const attempted = await contentItems.setContentItemStatus(db.db, item.id, 'approved');
    expect(attempted?.changed).toBe(false);
    expect(attempted?.item.status).toBe('gated');
  });
});
