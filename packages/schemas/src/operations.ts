import { z } from 'zod';
import { FAILURE_KINDS, JOB_STATUSES, WORKFLOW_RUN_STATUSES } from './enums.js';
import { idSchema, isoDateTime, timestamps } from './common.js';

/** Execution record for any multi-step operation, keyed by correlation id. */
export const workflowRun = z
  .object({
    id: idSchema('run'),
    workflow: z.string().min(1).max(80),
    status: z.enum(WORKFLOW_RUN_STATUSES),
    correlation_id: z.string(),
    /** The entity this run is about, e.g. a learning event or content item id. */
    subject_id: z.string().max(80).nullable(),
    started_at: isoDateTime,
    finished_at: isoDateTime.nullable(),
    duration_ms: z.number().int().min(0).nullable(),
    input_summary: z.record(z.unknown()).nullable(),
    output_summary: z.record(z.unknown()).nullable(),
  })
  .merge(timestamps);
export type WorkflowRun = z.infer<typeof workflowRun>;

export const errorEvent = z
  .object({
    id: idSchema('ev'),
    workflow: z.string().min(1).max(80),
    step: z.string().max(80).nullable(),
    kind: z.enum(FAILURE_KINDS),
    code: z.string().min(2).max(80),
    message: z.string().max(4000),
    correlation_id: z.string(),
    subject_id: z.string().max(80).nullable(),
    /** Redacted context only - never raw provider payloads or credentials. */
    details: z.record(z.unknown()).nullable(),
    occurred_at: isoDateTime,
  })
  .merge(timestamps);
export type ErrorEvent = z.infer<typeof errorEvent>;

export const job = z
  .object({
    id: idSchema('job'),
    job_type: z.string().min(1).max(60),
    status: z.enum(JOB_STATUSES),
    /** Deterministic key; a duplicate enqueue of pending work is a no-op. */
    dedupe_key: z.string().min(4).max(200),
    payload: z.record(z.unknown()),
    run_after: isoDateTime,
    attempts: z.number().int().min(0),
    max_attempts: z.number().int().min(1),
    last_error: z.string().max(2000).nullable(),
    locked_at: isoDateTime.nullable(),
    locked_by: z.string().max(80).nullable(),
    correlation_id: z.string(),
  })
  .merge(timestamps);
export type Job = z.infer<typeof job>;

/** Raw inbound webhook deliveries, recorded before processing so replays are detectable. */
export const webhookDelivery = z
  .object({
    id: idSchema('wh'),
    provider: z.string().min(1).max(40),
    delivery_id: z.string().min(1).max(200),
    event_type: z.string().max(80).nullable(),
    received_at: isoDateTime,
    processed_at: isoDateTime.nullable(),
    result: z.string().max(200).nullable(),
    correlation_id: z.string(),
  })
  .merge(timestamps);
export type WebhookDelivery = z.infer<typeof webhookDelivery>;
