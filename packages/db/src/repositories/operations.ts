import type { ErrorEvent, WorkflowRun, WorkflowRunStatus } from '@sce/schemas';
import { newId } from '@sce/utils';
import type { Db } from '../pool.js';

/** Execution and failure records. Every stage writes here so stalls are diagnosable. */

export const startWorkflowRun = async (
  db: Db,
  input: {
    workflow: string;
    correlationId: string;
    subjectId?: string | null;
    input?: Record<string, unknown>;
  },
): Promise<string> => {
  const id = newId('workflowRun');
  await db.query(
    `INSERT INTO workflow_runs (id, workflow, status, correlation_id, subject_id, input_summary)
     VALUES ($1, $2, 'started', $3, $4, $5::jsonb)`,
    [
      id,
      input.workflow,
      input.correlationId,
      input.subjectId ?? null,
      JSON.stringify(input.input ?? {}),
    ],
  );
  return id;
};

export const finishWorkflowRun = async (
  db: Db,
  id: string,
  status: Exclude<WorkflowRunStatus, 'started'>,
  output?: Record<string, unknown>,
): Promise<void> => {
  await db.query(
    `UPDATE workflow_runs
       SET status = $2,
           finished_at = now(),
           duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
           output_summary = $3::jsonb
     WHERE id = $1 AND status = 'started'`,
    [id, status, JSON.stringify(output ?? {})],
  );
};

export const recordError = async (
  db: Db,
  input: {
    workflow: string;
    step?: string | null;
    kind: ErrorEvent['kind'];
    code: string;
    message: string;
    correlationId: string;
    subjectId?: string | null;
    details?: Record<string, unknown> | null;
  },
): Promise<string> => {
  const id = newId('errorEvent');
  await db.query(
    `INSERT INTO error_events (id, workflow, step, kind, code, message, correlation_id, subject_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      id,
      input.workflow,
      input.step ?? null,
      input.kind,
      input.code,
      input.message.slice(0, 4000),
      input.correlationId,
      input.subjectId ?? null,
      input.details ? JSON.stringify(input.details) : null,
    ],
  );
  return id;
};

export const listWorkflowRuns = async (
  db: Db,
  options: { correlationId?: string; workflow?: string; limit?: number } = {},
): Promise<WorkflowRun[]> => {
  const { rows } = await db.query<WorkflowRun>(
    `SELECT * FROM workflow_runs
     WHERE ($1::text IS NULL OR correlation_id = $1)
       AND ($2::text IS NULL OR workflow = $2)
     ORDER BY started_at DESC LIMIT $3`,
    [options.correlationId ?? null, options.workflow ?? null, Math.min(options.limit ?? 50, 200)],
  );
  return rows;
};

export const listErrorEvents = async (
  db: Db,
  options: { correlationId?: string; limit?: number } = {},
): Promise<ErrorEvent[]> => {
  const { rows } = await db.query<ErrorEvent>(
    `SELECT * FROM error_events
     WHERE ($1::text IS NULL OR correlation_id = $1)
     ORDER BY occurred_at DESC LIMIT $2`,
    [options.correlationId ?? null, Math.min(options.limit ?? 50, 200)],
  );
  return rows;
};

/** Records an inbound webhook delivery. Returns false when this delivery was already seen. */
export const recordWebhookDelivery = async (
  db: Db,
  input: { provider: string; deliveryId: string; eventType?: string | null; correlationId: string },
): Promise<{ id: string; isNew: boolean }> => {
  const id = newId('webhookDelivery');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO webhook_deliveries (id, provider, delivery_id, event_type, correlation_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, delivery_id) DO NOTHING
     RETURNING id`,
    [id, input.provider, input.deliveryId, input.eventType ?? null, input.correlationId],
  );
  if (rows[0]) return { id: rows[0].id, isNew: true };

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM webhook_deliveries WHERE provider = $1 AND delivery_id = $2',
    [input.provider, input.deliveryId],
  );
  return { id: existing.rows[0]!.id, isNew: false };
};

export const markWebhookProcessed = async (db: Db, id: string, result: string): Promise<void> => {
  await db.query(
    `UPDATE webhook_deliveries SET processed_at = now(), result = $2 WHERE id = $1 AND processed_at IS NULL`,
    [id, result.slice(0, 200)],
  );
};
