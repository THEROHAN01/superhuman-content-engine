import { z } from 'zod';
import { CAPTURE_SOURCES, LEARNING_EVENT_STATUSES, LEARNING_KINDS, TOPICS } from './enums.js';
import { correlationId, idSchema, isoDateTime, sha256Hex, timestamps } from './common.js';

/** What a human (or an integration) must supply to capture a learning event. Deliberately small. */
export const captureLearningEventInput = z.object({
  /** The raw note. Stored unchanged, forever. */
  text: z.string().trim().min(10, 'a learning note needs at least 10 characters').max(20_000),
  title: z.string().trim().min(3).max(200).optional(),
  source: z.enum(CAPTURE_SOURCES).default('http'),
  /** Provider-side id (telegram message id, notion page id, github delivery id) for deduplication. */
  external_id: z.string().trim().min(1).max(200).optional(),
  captured_at: isoDateTime.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /** Free-form capture context, e.g. {"chat_id": 1, "notion_db": "..."} - never credentials. */
  context: z.record(z.unknown()).default({}),
  correlation_id: correlationId.optional(),
});
export type CaptureLearningEventInput = z.infer<typeof captureLearningEventInput>;

export const learningEventClassification = z.object({
  kind: z.enum(LEARNING_KINDS),
  primary_topic: z.enum(TOPICS),
  secondary_topics: z.array(z.enum(TOPICS)).max(3).default([]),
  /** Technical entities mentioned: Redis, PostgreSQL, JWT, WebSockets... */
  entities: z.array(z.string().min(1).max(60)).max(20).default([]),
  /** The classifier's view of whether this could become content. Never auto-publishes. */
  content_worthy: z.boolean(),
  content_worthiness_reason: z.string().min(3).max(500),
  confidence: z.number().min(0).max(1),
});
export type LearningEventClassification = z.infer<typeof learningEventClassification>;

export const learningEvent = z
  .object({
    id: idSchema('le'),
    status: z.enum(LEARNING_EVENT_STATUSES),
    source: z.enum(CAPTURE_SOURCES),
    external_id: z.string().nullable(),
    /** Exactly what was captured, never rewritten. */
    raw_text: z.string().min(1),
    normalized_text: z.string().nullable(),
    title: z.string().nullable(),
    content_hash: sha256Hex,
    /** Set when this event duplicates an earlier one; provenance is kept, not discarded. */
    duplicate_of: idSchema('le').nullable(),
    classification: learningEventClassification.nullable(),
    tags: z.array(z.string()),
    context: z.record(z.unknown()),
    captured_at: isoDateTime,
    correlation_id: z.string(),
  })
  .merge(timestamps);
export type LearningEvent = z.infer<typeof learningEvent>;

export const captureLearningEventResult = z.object({
  learning_event: learningEvent,
  /** True when an identical note already existed; the caller gets the original id back. */
  duplicate: z.boolean(),
  correlation_id: z.string(),
});
export type CaptureLearningEventResult = z.infer<typeof captureLearningEventResult>;
