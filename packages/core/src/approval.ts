import { approvals, contentAtoms, contentIdeas, contentItems, operations } from '@sce/db';
import type { ApprovalCard, LlmAdapter, TelegramAdapter } from '@sce/adapters';
import { idempotencyKey, newId, permanent, type Result } from '@sce/utils';
import type { Approval, ApprovalAction, ContentItem } from '@sce/schemas';
import { APPROVAL_ACTIONS } from '@sce/schemas';
import type { ServiceContext } from './context.js';
import { generateContentItems } from './generate.js';

/**
 * Human approval.
 *
 * Nothing becomes publishable without a decision recorded here, and every decision is recorded
 * exactly once even when Telegram delivers the same button press twice. Approval history is
 * append-only: a regeneration creates a new version rather than editing the one that was judged.
 */

/** Short codes keep callback data inside Telegram's 64-byte limit. */
const ACTION_CODES: Record<ApprovalAction, string> = {
  approve: 'ap',
  reject: 'rj',
  regenerate: 'rg',
  request_change: 'rc',
  schedule_review: 'sr',
};

const CODE_TO_ACTION = Object.fromEntries(
  Object.entries(ACTION_CODES).map(([action, code]) => [code, action as ApprovalAction]),
) as Record<string, ApprovalAction>;

/**
 * Deterministic action id for one (item, version, action).
 *
 * Deterministic is the point: the same button always carries the same id, so a duplicate delivery
 * collides on the unique index instead of creating a second decision.
 */
export const actionId = (itemId: string, version: number, action: ApprovalAction): string =>
  idempotencyKey(itemId, version, action).slice(0, 32);

/**
 * Encodes a button payload: `sce:<code>:<item id>:<version>`.
 *
 * The item reference travels in the payload because Telegram gives the webhook nothing else to
 * identify the content by - only the callback data comes back. It is about 40 bytes, inside
 * Telegram's 64-byte limit, and the action id is derived from the same three values, so a button
 * cannot decide a version it was not rendered for.
 */
export const encodeCallbackData = (
  itemId: string,
  version: number,
  action: ApprovalAction,
): string => `sce:${ACTION_CODES[action]}:${itemId}:${version}`;

export interface DecodedCallback {
  action: ApprovalAction;
  itemId: string;
  version: number;
  actionId: string;
}

export const decodeCallbackData = (data: string): DecodedCallback | null => {
  const match = /^sce:([a-z]{2}):(it_[0-9a-z]+):(\d{1,4})$/.exec(data.trim());
  if (!match) return null;
  const action = CODE_TO_ACTION[match[1]!];
  if (!action || !APPROVAL_ACTIONS.includes(action)) return null;

  const itemId = match[2]!;
  const version = Number(match[3]);
  return { action, itemId, version, actionId: actionId(itemId, version, action) };
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Renders the approval card: what it is, where it came from, and what the gate thought. */
export const renderApprovalCard = (input: {
  item: ContentItem;
  ideaTitle: string;
  atomTitle: string;
  sources: Array<{ url: string; title: string }>;
}): string => {
  const { item } = input;
  const gate = item.quality_gate;
  const blocks = gate?.reasons.filter((r) => r.severity === 'block') ?? [];
  const warns = gate?.reasons.filter((r) => r.severity === 'warn') ?? [];

  const verdictLine = gate
    ? `${gate.verdict.toUpperCase()} (score ${gate.score}, ${gate.gate_version})`
    : 'not gated';

  const preview =
    item.draft.body.length > 1200
      ? `${item.draft.body.slice(0, 1200)}\n[...truncated for preview]`
      : item.draft.body;

  const lines = [
    `<b>${escapeHtml(item.format)}</b> for ${escapeHtml(item.platform)} - v${item.version}`,
    `<i>${escapeHtml(input.ideaTitle)}</i>`,
    '',
    `<pre>${escapeHtml(preview)}</pre>`,
    '',
    `Quality gate: <b>${escapeHtml(verdictLine)}</b>`,
    ...blocks.map((reason) => `  BLOCK ${escapeHtml(reason.code)}: ${escapeHtml(reason.detail)}`),
    ...warns.map((reason) => `  warn ${escapeHtml(reason.code)}: ${escapeHtml(reason.detail)}`),
    '',
    `From learning: ${escapeHtml(input.atomTitle)}`,
    ...(input.sources.length > 0
      ? [`Sources:`, ...input.sources.slice(0, 3).map((s) => `  ${escapeHtml(s.url)}`)]
      : ['Sources: none attached']),
    '',
    `Content id: <code>${escapeHtml(item.id)}</code>`,
  ];

  return lines.join('\n').slice(0, 4000);
};

export interface SendForApprovalOptions {
  telegram: TelegramAdapter;
  chatId: string;
}

export interface SendForApprovalResult {
  item: ContentItem;
  messageId: string | null;
  /** True when the item was already awaiting approval and no new card was sent. */
  unchanged: boolean;
}

export const sendForApproval = async (
  ctx: ServiceContext,
  itemId: string,
  options: SendForApprovalOptions,
): Promise<Result<SendForApprovalResult>> => {
  const item = await contentItems.findContentItem(ctx.db, itemId);
  if (!item)
    return { ok: false, error: permanent('E_ITEM_NOT_FOUND', `no content item ${itemId}`) };

  if (item.status === 'pending_approval') {
    return { ok: true, value: { item, messageId: null, unchanged: true } };
  }
  if (item.status !== 'gated') {
    return {
      ok: false,
      error: permanent(
        'E_ITEM_NOT_GATED',
        `content item ${itemId} is ${item.status}; only gated items go to approval`,
        { status: item.status },
      ),
    };
  }
  if (item.quality_gate?.verdict === 'reject') {
    return {
      ok: false,
      error: permanent('E_ITEM_REJECTED_BY_GATE', 'the quality gate rejected this draft'),
    };
  }

  const idea = await contentIdeas.findIdea(ctx.db, item.content_idea_id);
  const atom = await contentAtoms.findAtom(ctx.db, item.content_atom_id);

  const card: ApprovalCard = {
    chatId: options.chatId,
    text: renderApprovalCard({
      item,
      ideaTitle: idea?.title ?? '(idea missing)',
      atomTitle: atom?.title ?? '(atom missing)',
      sources: item.draft.source_attributions.map((a) => ({ url: a.url, title: a.title })),
    }),
    buttons: [
      [
        { label: 'Approve', data: encodeCallbackData(item.id, item.version, 'approve') },
        { label: 'Reject', data: encodeCallbackData(item.id, item.version, 'reject') },
      ],
      [
        { label: 'Regenerate', data: encodeCallbackData(item.id, item.version, 'regenerate') },
        {
          label: 'Request change',
          data: encodeCallbackData(item.id, item.version, 'request_change'),
        },
      ],
    ],
    correlationId: item.correlation_id,
  };

  const sent = await options.telegram.send(card);
  if (!sent.ok) {
    await operations.recordError(ctx.db, {
      workflow: 'approval_request_v1',
      step: 'send',
      kind: sent.error.kind,
      code: sent.error.code,
      message: sent.error.message,
      correlationId: item.correlation_id,
      subjectId: item.id,
    });
    return { ok: false, error: sent.error };
  }

  const transition = await contentItems.setContentItemStatus(ctx.db, item.id, 'pending_approval');
  return {
    ok: true,
    value: {
      item: transition?.item ?? item,
      messageId: sent.value.messageId,
      unchanged: false,
    },
  };
};

export interface DecisionInput {
  actionId: string;
  action: ApprovalAction;
  decidedBy: string;
  channel?: string;
  note?: string | null;
  externalCallbackId?: string | null;
  /** Required to locate the item when the decision arrives from a callback. */
  itemId?: string;
}

export interface DecisionOptions {
  llm?: LlmAdapter;
}

export interface DecisionResult {
  approval: Approval;
  item: ContentItem;
  /** False when this decision had already been recorded (duplicate delivery). */
  applied: boolean;
  /** Set when a regeneration produced a new version. */
  regenerated_item_id?: string;
}

/**
 * Applies a decision.
 *
 * Idempotent in both directions: an already-recorded `action_id` or callback id returns the
 * original decision without re-applying it, and state transitions are monotonic, so a late
 * duplicate cannot resurrect rejected content or re-approve something already published.
 */
export const recordDecision = async (
  ctx: ServiceContext,
  input: DecisionInput,
  options: DecisionOptions = {},
): Promise<Result<DecisionResult>> => {
  const existing =
    (await approvals.findByActionId(ctx.db, input.actionId)) ??
    (input.externalCallbackId
      ? await approvals.findByCallbackId(
          ctx.db,
          input.channel ?? 'telegram',
          input.externalCallbackId,
        )
      : null);

  if (existing) {
    const item = await contentItems.findContentItem(ctx.db, existing.content_item_id);
    if (!item) {
      return {
        ok: false,
        error: permanent('E_ITEM_NOT_FOUND', 'decision references a missing item'),
      };
    }
    return { ok: true, value: { approval: existing, item, applied: false } };
  }

  const itemId = input.itemId;
  if (!itemId) {
    // An unknown action id with no item is an expired or forged button - refuse, do not guess.
    return {
      ok: false,
      error: permanent('E_UNKNOWN_ACTION', 'unknown or expired action id', {
        actionId: input.actionId,
      }),
    };
  }

  const item = await contentItems.findContentItem(ctx.db, itemId);
  if (!item)
    return { ok: false, error: permanent('E_ITEM_NOT_FOUND', `no content item ${itemId}`) };

  // The button must belong to this item and version; a stale card cannot decide a newer draft.
  if (actionId(item.id, item.version, input.action) !== input.actionId) {
    return {
      ok: false,
      error: permanent(
        'E_STALE_ACTION',
        'this button belongs to a different version of the content',
        {
          item_version: item.version,
        },
      ),
    };
  }

  if (item.status !== 'pending_approval') {
    return {
      ok: false,
      error: permanent('E_ITEM_NOT_PENDING', `content item ${item.id} is ${item.status}`, {
        status: item.status,
      }),
    };
  }

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'approval_decide_v1',
    correlationId: item.correlation_id,
    subjectId: item.id,
    input: { action: input.action },
  });

  const { approval, inserted } = await approvals.insertApproval(ctx.db, {
    id: newId('approval'),
    content_item_id: item.id,
    content_item_version: item.version,
    action: input.action,
    action_id: input.actionId,
    decided_by: input.decidedBy,
    channel: input.channel ?? 'telegram',
    note: input.note ?? null,
    external_callback_id: input.externalCallbackId ?? null,
    correlation_id: item.correlation_id,
  });

  if (!inserted) {
    await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', { duplicate: true });
    return { ok: true, value: { approval, item, applied: false } };
  }

  let updated = item;
  let regeneratedId: string | undefined;

  switch (input.action) {
    case 'approve': {
      const transition = await contentItems.setContentItemStatus(ctx.db, item.id, 'approved');
      updated = transition?.item ?? item;
      break;
    }
    case 'reject': {
      const transition = await contentItems.setContentItemStatus(ctx.db, item.id, 'rejected');
      updated = transition?.item ?? item;
      break;
    }
    case 'regenerate': {
      if (!options.llm) {
        return {
          ok: false,
          error: permanent('E_NO_GENERATOR', 'regeneration requires a generator to be configured'),
        };
      }
      // A new version is created; the judged version is superseded, never overwritten.
      const regenerated = await generateContentItems(ctx, item.content_idea_id, {
        llm: options.llm,
        formats: [item.format],
        regenerate: true,
      });
      if (regenerated.ok && regenerated.value.items[0]) {
        regeneratedId = regenerated.value.items[0].item.id;
      }
      const refreshed = await contentItems.findContentItem(ctx.db, item.id);
      updated = refreshed ?? item;
      break;
    }
    case 'request_change':
    case 'schedule_review': {
      // The decision is recorded; the item stays where it is, awaiting a follow-up.
      updated = item;
      break;
    }
  }

  ctx.logger
    .child({ workflow: 'approval_decide_v1', content_item_id: item.id })
    .info(
      { action: input.action, decided_by: input.decidedBy, status: updated.status },
      'approval decision recorded',
    );

  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
    action: input.action,
    status: updated.status,
    ...(regeneratedId ? { regenerated_item_id: regeneratedId } : {}),
  });

  return {
    ok: true,
    value: {
      approval,
      item: updated,
      applied: true,
      ...(regeneratedId ? { regenerated_item_id: regeneratedId } : {}),
    },
  };
};

export const listApprovalsForItem = async (ctx: ServiceContext, itemId: string) =>
  approvals.listApprovalsForItem(ctx.db, itemId);
