import { z } from 'zod';
import { APPROVAL_ACTIONS } from './enums.js';
import { idSchema, isoDateTime, timestamps } from './common.js';

/**
 * A recorded human decision. Approvals are append-only: a later decision never edits an earlier
 * row, so the audit trail of what was approved (and by whom) stays intact.
 */
export const approval = z
  .object({
    id: idSchema('ap'),
    content_item_id: idSchema('it'),
    /** Version of the item the human actually saw when deciding. */
    content_item_version: z.number().int().min(1),
    action: z.enum(APPROVAL_ACTIONS),
    /** Stable id embedded in the Telegram button; the idempotency key for callbacks. */
    action_id: z.string().min(8).max(120),
    decided_by: z.string().min(1).max(120),
    channel: z.string().min(1).max(40),
    note: z.string().max(2000).nullable(),
    /** Provider-side callback id, so a redelivered callback is recognised as the same decision. */
    external_callback_id: z.string().max(200).nullable(),
    decided_at: isoDateTime,
    correlation_id: z.string(),
  })
  .merge(timestamps);
export type Approval = z.infer<typeof approval>;

export const approvalRequest = z.object({
  content_item_id: idSchema('it'),
  action: z.enum(APPROVAL_ACTIONS),
  action_id: z.string().min(8).max(120),
  decided_by: z.string().min(1).max(120),
  channel: z.string().min(1).max(40).default('telegram'),
  note: z.string().max(2000).optional(),
  external_callback_id: z.string().max(200).optional(),
  correlation_id: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof approvalRequest>;
