import type { Approval, ApprovalAction } from '@sce/schemas';
import { approval as approvalSchema } from '@sce/schemas';
import type { Db } from '../pool.js';

const COLUMNS = `id, content_item_id, content_item_version, action, action_id, decided_by, channel,
  note, external_callback_id, decided_at, correlation_id, created_at, updated_at`;

const toDomain = (row: unknown): Approval => approvalSchema.parse(row);

export interface InsertApproval {
  id: string;
  content_item_id: string;
  content_item_version: number;
  action: ApprovalAction;
  action_id: string;
  decided_by: string;
  channel: string;
  note: string | null;
  external_callback_id: string | null;
  correlation_id: string;
}

/**
 * Records a decision exactly once.
 *
 * Two independent unique keys protect this: `action_id` (the stable id embedded in the button, so
 * a double tap resolves to one decision) and `(channel, external_callback_id)` (so a redelivered
 * Telegram update is recognised as the same press). A replay returns the original row instead of
 * erroring, so the caller's retry converges.
 */
export const insertApproval = async (
  db: Db,
  input: InsertApproval,
): Promise<{ approval: Approval; inserted: boolean }> => {
  const { rows } = await db.query(
    `INSERT INTO approvals
       (id, content_item_id, content_item_version, action, action_id, decided_by, channel, note,
        external_callback_id, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.content_item_id,
      input.content_item_version,
      input.action,
      input.action_id,
      input.decided_by,
      input.channel,
      input.note,
      input.external_callback_id,
      input.correlation_id,
    ],
  );

  if (rows[0]) return { approval: toDomain(rows[0]), inserted: true };

  const existing =
    (await findByActionId(db, input.action_id)) ??
    (input.external_callback_id
      ? await findByCallbackId(db, input.channel, input.external_callback_id)
      : null);
  if (!existing) throw new Error('approval insert conflicted but no existing decision was found');
  return { approval: existing, inserted: false };
};

export const findByActionId = async (db: Db, actionId: string): Promise<Approval | null> => {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM approvals WHERE action_id = $1`, [
    actionId,
  ]);
  return rows[0] ? toDomain(rows[0]) : null;
};

export const findByCallbackId = async (
  db: Db,
  channel: string,
  callbackId: string,
): Promise<Approval | null> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM approvals WHERE channel = $1 AND external_callback_id = $2`,
    [channel, callbackId],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

export const listApprovalsForItem = async (db: Db, itemId: string): Promise<Approval[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM approvals WHERE content_item_id = $1 ORDER BY decided_at`,
    [itemId],
  );
  return rows.map(toDomain);
};

export const listApprovals = async (db: Db, limit = 50): Promise<Approval[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM approvals ORDER BY decided_at DESC LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return rows.map(toDomain);
};
