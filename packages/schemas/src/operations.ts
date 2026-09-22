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

/** Report status. Mirrored by a SQL CHECK in migration 0002. */
export const WEEKLY_REPORT_STATUSES = ['generated', 'delivered', 'failed'] as const;
export type WeeklyReportStatus = (typeof WEEKLY_REPORT_STATUSES)[number];

const countsSchema = z.object({
  learning_events: z.number().int().min(0),
  learning_events_duplicate: z.number().int().min(0),
  content_atoms: z.number().int().min(0),
  content_ideas: z.number().int().min(0),
  drafts_generated: z.number().int().min(0),
  drafts_gated_pass: z.number().int().min(0),
  drafts_rejected_by_gate: z.number().int().min(0),
  approved: z.number().int().min(0),
  rejected_by_human: z.number().int().min(0),
  published: z.number().int().min(0),
  publications_failed: z.number().int().min(0),
});

const groupPerformance = z.object({
  key: z.string(),
  published: z.number().int().min(0),
  /** Null when no publication in the group has known impressions - never zero. */
  impressions: z.number().int().min(0).nullable(),
  engagements: z.number().int().min(0).nullable(),
  engagement_rate: z.number().min(0).nullable(),
  /** How many publications contributed a known denominator; the honesty qualifier. */
  measured: z.number().int().min(0),
});

export const weeklyReportBody = z.object({
  counts: countsSchema,
  /** Median hours from capture to publication, when both timestamps exist. */
  capture_to_publish_hours: z.number().min(0).nullable(),
  by_topic: z.array(groupPerformance),
  by_format: z.array(groupPerformance),
  by_platform: z.array(groupPerformance),
  by_hook_class: z.array(groupPerformance),
  signals: z.array(
    z.object({
      kind: z.enum(['strongest', 'weakest', 'note']),
      statement: z.string().max(500),
      /** Evidence behind the statement, so a claim can always be checked. */
      basis: z.string().max(500),
      confidence: z.enum(['low', 'medium', 'high']),
    }),
  ),
  failures: z.array(
    z.object({
      kind: z.string().max(60),
      detail: z.string().max(500),
      count: z.number().int().min(0),
    }),
  ),
  approval_backlog: z.array(
    z.object({
      content_item_id: idSchema('it'),
      format: z.string().max(40),
      waiting_hours: z.number().min(0),
      gate_verdict: z.string().max(20).nullable(),
    }),
  ),
  content_opportunities: z.array(
    z.object({ title: z.string().max(200), why: z.string().max(500), source: z.string().max(200) }),
  ),
  learning_suggestions: z.array(z.object({ topic: z.string().max(80), why: z.string().max(500) })),
});
export type WeeklyReportBody = z.infer<typeof weeklyReportBody>;

export const weeklyReport = z
  .object({
    id: idSchema('wr'),
    period_start: isoDateTime,
    period_end: isoDateTime,
    timezone: z.string().min(1),
    period_key: z.string().regex(/^\d{4}-W\d{2}$/),
    status: z.enum(WEEKLY_REPORT_STATUSES),
    generator_version: z.string().max(60),
    body: weeklyReportBody,
    delivered_at: isoDateTime.nullable(),
    delivery_error: z.string().max(2000).nullable(),
    correlation_id: z.string(),
  })
  .merge(timestamps);
export type WeeklyReport = z.infer<typeof weeklyReport>;
