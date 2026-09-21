/**
 * Every workflow status in one place. Each list is mirrored by a SQL CHECK constraint in
 * packages/db/migrations; `packages/db/src/enum-parity.test.ts` fails if the two ever drift.
 */

export const CAPTURE_SOURCES = ['http', 'telegram', 'notion', 'github', 'manual', 'seed'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const LEARNING_EVENT_STATUSES = [
  'received',
  'normalized',
  'classified',
  'atomized',
  'duplicate',
  'failed',
] as const;
export type LearningEventStatus = (typeof LEARNING_EVENT_STATUSES)[number];

/** Coarse kind of learning, used for routing and weekly reporting. */
export const LEARNING_KINDS = [
  'dsa',
  'core_engineering',
  'project_work',
  'book_research',
  'other',
] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/** Allowed topic taxonomy. Classification may only choose from this list. */
export const TOPICS = [
  'algorithms',
  'system_design',
  'backend',
  'databases',
  'distributed_systems',
  'networking',
  'security',
  'performance',
  'devops',
  'observability',
  'ai_ml',
  'frontend',
  'testing',
  'career',
  'product',
  'other',
] as const;
export type Topic = (typeof TOPICS)[number];

export const SOURCE_TYPES = [
  'official_docs',
  'rfc',
  'paper',
  'source_code',
  'engineering_blog',
  'book',
  'video',
  'other',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Ranked evidence quality; lower index is stronger. Used to pick which sources to keep. */
export const SOURCE_TYPE_RANK: Record<SourceType, number> = {
  official_docs: 1,
  rfc: 2,
  paper: 3,
  source_code: 4,
  engineering_blog: 5,
  book: 6,
  video: 7,
  other: 8,
};

export const EVIDENCE_STATUSES = [
  'not_required',
  'pending',
  'supported',
  'partially_supported',
  'unsupported',
  'needs_review',
  'research_failed',
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const CONTENT_ATOM_STATUSES = ['draft', 'enriched', 'ready', 'failed'] as const;
export type ContentAtomStatus = (typeof CONTENT_ATOM_STATUSES)[number];

export const CONTENT_ANGLES = [
  'insight',
  'misconception',
  'mental_model',
  'implementation_lesson',
  'failure_mode',
  'project_story',
  'checklist',
  'comparison',
] as const;
export type ContentAngle = (typeof CONTENT_ANGLES)[number];

export const CONTENT_IDEA_STATUSES = ['proposed', 'queued', 'rejected', 'used'] as const;
export type ContentIdeaStatus = (typeof CONTENT_IDEA_STATUSES)[number];

export const PLATFORMS = ['x', 'linkedin', 'instagram'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CONTENT_FORMATS = [
  'x_post',
  'x_thread',
  'linkedin_post',
  'reel_script',
  'carousel',
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const FORMAT_PLATFORM: Record<ContentFormat, Platform> = {
  x_post: 'x',
  x_thread: 'x',
  linkedin_post: 'linkedin',
  reel_script: 'instagram',
  carousel: 'instagram',
};

export const CONTENT_ITEM_STATUSES = [
  'draft',
  'gated',
  'pending_approval',
  'approved',
  'rejected',
  'scheduled',
  'published',
  'superseded',
  'failed',
] as const;
export type ContentItemStatus = (typeof CONTENT_ITEM_STATUSES)[number];

export const GATE_VERDICTS = ['pass', 'needs_review', 'reject'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

export const APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'regenerate',
  'request_change',
  'schedule_review',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const PUBLICATION_STATUSES = [
  'pending',
  'scheduled',
  'published',
  'failed',
  'retry_pending',
  'cancelled',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const METRIC_WINDOWS = ['24h', '7d', '30d', 'lifetime'] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const WORKFLOW_RUN_STATUSES = ['started', 'succeeded', 'failed'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const FAILURE_KINDS = ['transient', 'permanent'] as const;
export type FailureKindEnum = (typeof FAILURE_KINDS)[number];

/** Name -> values, consumed by the SQL/zod parity test. */
export const ENUMS = {
  capture_source: CAPTURE_SOURCES,
  learning_event_status: LEARNING_EVENT_STATUSES,
  learning_kind: LEARNING_KINDS,
  topic: TOPICS,
  source_type: SOURCE_TYPES,
  evidence_status: EVIDENCE_STATUSES,
  content_atom_status: CONTENT_ATOM_STATUSES,
  content_angle: CONTENT_ANGLES,
  content_idea_status: CONTENT_IDEA_STATUSES,
  platform: PLATFORMS,
  content_format: CONTENT_FORMATS,
  content_item_status: CONTENT_ITEM_STATUSES,
  gate_verdict: GATE_VERDICTS,
  approval_action: APPROVAL_ACTIONS,
  publication_status: PUBLICATION_STATUSES,
  metric_window: METRIC_WINDOWS,
  job_status: JOB_STATUSES,
  workflow_run_status: WORKFLOW_RUN_STATUSES,
  failure_kind: FAILURE_KINDS,
} as const satisfies Record<string, readonly string[]>;
