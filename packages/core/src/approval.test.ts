import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  createFailingTelegramAdapter,
  createMockLlmAdapter,
  createMockTelegramAdapter,
  TELEGRAM_LIMITS,
} from '@sce/adapters';
import {
  contentHash,
  createLogger,
  fixedClock,
  newCorrelationId,
  newId,
  parseEnv,
} from '@sce/utils';
import type { ContentItem } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import {
  actionId,
  decodeCallbackData,
  encodeCallbackData,
  recordDecision,
  renderApprovalCard,
  sendForApproval,
} from './approval.js';
import { runQualityGate } from './quality-gate.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describe('callback encoding', () => {
  it('is deterministic for the same item, version and action', () => {
    expect(encodeCallbackData('it_abc', 1, 'approve')).toBe(
      encodeCallbackData('it_abc', 1, 'approve'),
    );
  });

  it('differs per action and per version', () => {
    expect(encodeCallbackData('it_abc', 1, 'approve')).not.toBe(
      encodeCallbackData('it_abc', 1, 'reject'),
    );
    expect(encodeCallbackData('it_abc', 1, 'approve')).not.toBe(
      encodeCallbackData('it_abc', 2, 'approve'),
    );
  });

  it('fits inside Telegram’s 64-byte callback limit', () => {
    const data = encodeCallbackData('it_0mubq8npe58f9f32516834d8e', 12, 'request_change');
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(TELEGRAM_LIMITS.callbackDataBytes);
  });

  it('round-trips the action, the item and the version', () => {
    const data = encodeCallbackData('it_abc123', 3, 'regenerate');
    expect(decodeCallbackData(data)).toEqual({
      action: 'regenerate',
      itemId: 'it_abc123',
      version: 3,
      actionId: actionId('it_abc123', 3, 'regenerate'),
    });
  });

  it('rejects malformed or forged payloads', () => {
    expect(decodeCallbackData('nonsense')).toBeNull();
    expect(decodeCallbackData('sce:xx:it_abc:1')).toBeNull(); // unknown action code
    expect(decodeCallbackData('sce:ap:ca_abc:1')).toBeNull(); // not a content item id
    expect(decodeCallbackData('sce:ap:it_abc')).toBeNull(); // no version
  });
});

describeDb('approval loop', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const llm = createMockLlmAdapter();

  const gatedItem = async (options: { withRealSource?: boolean } = {}): Promise<ContentItem> => {
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

    if (options.withRealSource !== false) {
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
      evidence_required: true,
      dedupe_hash: contentHash(newId('contentIdea')),
      rejection_reason: null,
      score: 0.7,
      prompt_version: 'ideation.v1',
    });

    const body =
      'A stolen refresh token looks exactly like a legitimate one, because both present the same credential. Rotation invalidates the previous token on every refresh, so a replayed JWT is proof of theft.';
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

    const gate = await runQualityGate(ctx, item.id);
    if (!gate.ok) throw new Error('setup: gate failed');
    return gate.value.item;
  };

  beforeAll(async () => {
    db = await createTestDb('approval');
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

  it('sends a card containing the content, its gate result, its source and its id', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    const result = await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.item.status).toBe('pending_approval');

    const card = telegram.sent[0]!;
    expect(card.chatId).toBe('123');
    expect(card.text).toContain(item.id);
    expect(card.text).toContain('x_post');
    expect(card.text).toContain('Quality gate');
    expect(card.buttons.flat().map((b) => b.label)).toEqual([
      'Approve',
      'Reject',
      'Regenerate',
      'Request change',
    ]);
  });

  it('refuses to send an item the gate rejected', async () => {
    const item = await gatedItem({ withRealSource: false });
    await contentItems.setContentItemStatus(db.db, item.id, 'rejected');
    const telegram = createMockTelegramAdapter();

    const result = await sendForApproval(ctx, item.id, { telegram, chatId: '123' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['E_ITEM_NOT_GATED', 'E_ITEM_REJECTED_BY_GATE']).toContain(result.error.code);
    expect(telegram.sent).toHaveLength(0);
  });

  it('does not resend a card for an item already awaiting approval', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    await sendForApproval(ctx, item.id, { telegram, chatId: '123' });
    const second = await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    expect(second.ok && second.value.unchanged).toBe(true);
    expect(telegram.sent).toHaveLength(1);
  });

  it('records a failure when Telegram is unreachable and leaves the item gated', async () => {
    const item = await gatedItem();
    const result = await sendForApproval(ctx, item.id, {
      telegram: createFailingTelegramAdapter(),
      chatId: '123',
    });

    expect(result.ok).toBe(false);
    const stored = await contentItems.findContentItem(db.db, item.id);
    expect(stored?.status).toBe('gated');
  });

  it('approve moves the item to approved and stores the decision', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    const result = await recordDecision(ctx, {
      actionId: actionId(item.id, item.version, 'approve'),
      action: 'approve',
      decidedBy: 'rohan',
      itemId: item.id,
      externalCallbackId: 'cbq-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);
    expect(result.value.item.status).toBe('approved');

    const stored = await approvalsRepo.listApprovalsForItem(db.db, item.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      action: 'approve',
      decided_by: 'rohan',
      content_item_version: item.version,
    });
  });

  it('a duplicate callback delivery does not create a second decision or transition', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    const input = {
      actionId: actionId(item.id, item.version, 'approve'),
      action: 'approve' as const,
      decidedBy: 'rohan',
      itemId: item.id,
      externalCallbackId: 'cbq-duplicate',
    };

    const first = await recordDecision(ctx, input);
    const second = await recordDecision(ctx, input);
    const third = await recordDecision(ctx, { ...input, externalCallbackId: 'cbq-different' });

    expect(first.ok && first.value.applied).toBe(true);
    expect(second.ok && second.value.applied).toBe(false);
    expect(third.ok && third.value.applied).toBe(false); // same action id, different delivery

    const stored = await approvalsRepo.listApprovalsForItem(db.db, item.id);
    expect(stored).toHaveLength(1);
  });

  it('concurrent presses of the same button record one decision', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    const input = {
      actionId: actionId(item.id, item.version, 'approve'),
      action: 'approve' as const,
      decidedBy: 'rohan',
      itemId: item.id,
    };
    const results = await Promise.all([
      recordDecision(ctx, { ...input, externalCallbackId: 'c1' }),
      recordDecision(ctx, { ...input, externalCallbackId: 'c2' }),
      recordDecision(ctx, { ...input, externalCallbackId: 'c3' }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const stored = await approvalsRepo.listApprovalsForItem(db.db, item.id);
    expect(stored).toHaveLength(1);
  });

  it('reject blocks publishing', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    const result = await recordDecision(ctx, {
      actionId: actionId(item.id, item.version, 'reject'),
      action: 'reject',
      decidedBy: 'rohan',
      itemId: item.id,
    });

    expect(result.ok && result.value.item.status).toBe('rejected');

    // A later approval of the same (now rejected) item is refused.
    const late = await recordDecision(ctx, {
      actionId: actionId(item.id, item.version, 'approve'),
      action: 'approve',
      decidedBy: 'rohan',
      itemId: item.id,
    });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error.code).toBe('E_ITEM_NOT_PENDING');
  });

  it('regenerate creates a new version and preserves the judged one', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    const result = await recordDecision(
      ctx,
      {
        actionId: actionId(item.id, item.version, 'regenerate'),
        action: 'regenerate',
        decidedBy: 'rohan',
        itemId: item.id,
      },
      { llm },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.regenerated_item_id).toBeTruthy();

    const versions = await contentItems.listItemsForIdea(db.db, item.content_idea_id);
    expect(versions).toHaveLength(2);
    const original = versions.find((v) => v.id === item.id)!;
    expect(original.status).toBe('superseded');
    expect(original.draft.body).toBe(item.draft.body); // the judged version is intact

    // The decision that was made about the original is still on record.
    const decisions = await approvalsRepo.listApprovalsForItem(db.db, item.id);
    expect(decisions.map((d) => d.action)).toEqual(['regenerate']);
  });

  it('request_change records the decision without changing status', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    const result = await recordDecision(ctx, {
      actionId: actionId(item.id, item.version, 'request_change'),
      action: 'request_change',
      decidedBy: 'rohan',
      note: 'lead with the failure, not the mechanism',
      itemId: item.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.item.status).toBe('pending_approval');
    expect(result.value.approval.note).toContain('lead with the failure');
  });

  it('refuses an unknown or expired action id', async () => {
    const result = await recordDecision(ctx, {
      actionId: 'f'.repeat(32),
      action: 'approve',
      decidedBy: 'rohan',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_UNKNOWN_ACTION');
  });

  it('refuses a button from a stale version of the content', async () => {
    const item = await gatedItem();
    const telegram = createMockTelegramAdapter();
    await sendForApproval(ctx, item.id, { telegram, chatId: '123' });

    const result = await recordDecision(ctx, {
      actionId: actionId(item.id, item.version + 1, 'approve'),
      action: 'approve',
      decidedBy: 'rohan',
      itemId: item.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_STALE_ACTION');
  });

  it('renders a card that fits inside the Telegram message limit', async () => {
    const item = await gatedItem();
    const card = renderApprovalCard({
      item: { ...item, draft: { ...item.draft, body: 'x'.repeat(6000) } },
      ideaTitle: 'A long idea title',
      atomTitle: 'An atom',
      sources: [{ url: 'https://rfc-editor.org/rfc/rfc6749', title: 'OAuth' }],
    });
    expect(card.length).toBeLessThanOrEqual(4096);
  });
});
