import type { LearningEvent, LearningEventStatus } from '@sce/schemas';
import { learningEvent as learningEventSchema } from '@sce/schemas';
import type { Db } from '../pool.js';

/** Row shape as stored; JSONB and arrays come back already parsed by node-postgres. */
interface LearningEventRow {
  id: string;
  status: LearningEventStatus;
  source: LearningEvent['source'];
  external_id: string | null;
  raw_text: string;
  normalized_text: string | null;
  title: string | null;
  content_hash: string;
  duplicate_of: string | null;
  classification: LearningEvent['classification'];
  tags: string[];
  context: Record<string, unknown>;
  captured_at: string;
  correlation_id: string;
  created_at: string;
  updated_at: string;
}

const toDomain = (row: LearningEventRow): LearningEvent => learningEventSchema.parse(row);

const COLUMNS = `id, status, source, external_id, raw_text, normalized_text, title, content_hash,
  duplicate_of, classification, tags, context, captured_at, correlation_id, created_at, updated_at`;

export interface InsertLearningEvent {
  id: string;
  source: LearningEvent['source'];
  external_id: string | null;
  raw_text: string;
  title: string | null;
  content_hash: string;
  tags: string[];
  context: Record<string, unknown>;
  captured_at: string;
  correlation_id: string;
}

export interface InsertResult {
  event: LearningEvent;
  /** False when an identical capture already existed and the stored row was returned instead. */
  inserted: boolean;
}

/**
 * Idempotent capture.
 *
 * The uniqueness guarantee lives in the database (`learning_events_content_hash_key`), not in a
 * read-then-write check, so two concurrent captures of the same note cannot both insert.
 */
export const insertLearningEvent = async (
  db: Db,
  input: InsertLearningEvent,
): Promise<InsertResult> => {
  const { rows } = await db.query<LearningEventRow>(
    `INSERT INTO learning_events
       (id, status, source, external_id, raw_text, title, content_hash, tags, context, captured_at, correlation_id)
     VALUES ($1, 'received', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     -- Bare DO NOTHING covers BOTH uniqueness rules (content hash and provider external id);
     -- naming one index would let a conflict on the other raise instead of deduplicating.
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.source,
      input.external_id,
      input.raw_text,
      input.title,
      input.content_hash,
      input.tags,
      JSON.stringify(input.context),
      input.captured_at,
      input.correlation_id,
    ],
  );

  if (rows.length > 0) return { event: toDomain(rows[0]!), inserted: true };

  // Nothing was inserted, so an equivalent event already exists. Resolve which rule matched and
  // return that row, so a retrying caller converges on the original instead of erroring.
  const existing =
    (await findByContentHash(db, input.content_hash)) ??
    (await findBySourceExternalId(db, input.source, input.external_id));
  if (!existing) {
    throw new Error('insert was skipped by ON CONFLICT but no existing learning event was found');
  }
  return { event: existing, inserted: false };
};

export const findLearningEvent = async (db: Db, id: string): Promise<LearningEvent | null> => {
  const { rows } = await db.query<LearningEventRow>(
    `SELECT ${COLUMNS} FROM learning_events WHERE id = $1`,
    [id],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

export const findByContentHash = async (
  db: Db,
  contentHash: string,
): Promise<LearningEvent | null> => {
  const { rows } = await db.query<LearningEventRow>(
    `SELECT ${COLUMNS} FROM learning_events WHERE content_hash = $1 AND duplicate_of IS NULL`,
    [contentHash],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

export const findBySourceExternalId = async (
  db: Db,
  source: LearningEvent['source'],
  externalId: string | null,
): Promise<LearningEvent | null> => {
  if (externalId === null) return null;
  const { rows } = await db.query<LearningEventRow>(
    `SELECT ${COLUMNS} FROM learning_events WHERE source = $1 AND external_id = $2`,
    [source, externalId],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

/**
 * Allowed predecessors for each status. Transitions are monotonic: a replayed normalization can
 * never pull an already-atomized event backwards, and a terminal status is never left.
 */
const ALLOWED_FROM: Record<LearningEventStatus, readonly LearningEventStatus[]> = {
  received: [],
  normalized: ['received'],
  classified: ['received', 'normalized'],
  atomized: ['normalized', 'classified'],
  duplicate: ['received', 'normalized', 'classified'],
  failed: ['received', 'normalized', 'classified'],
};

export interface AdvanceResult {
  event: LearningEvent;
  /** False when the transition was rejected as backwards or terminal; the row is unchanged. */
  changed: boolean;
}

export const advanceStatus = async (
  db: Db,
  id: string,
  status: LearningEventStatus,
  patch: Partial<
    Pick<LearningEvent, 'normalized_text' | 'title' | 'classification' | 'duplicate_of'>
  > = {},
): Promise<AdvanceResult | null> => {
  const { rows } = await db.query<LearningEventRow>(
    `UPDATE learning_events SET
       status = $3,
       normalized_text = COALESCE($4, normalized_text),
       title = COALESCE($5, title),
       classification = COALESCE($6::jsonb, classification),
       duplicate_of = COALESCE($7, duplicate_of)
     WHERE id = $1 AND status = ANY($2::text[])
     RETURNING ${COLUMNS}`,
    [
      id,
      ALLOWED_FROM[status],
      status,
      patch.normalized_text ?? null,
      patch.title ?? null,
      patch.classification ? JSON.stringify(patch.classification) : null,
      patch.duplicate_of ?? null,
    ],
  );

  if (rows[0]) return { event: toDomain(rows[0]), changed: true };

  const current = await findLearningEvent(db, id);
  return current ? { event: current, changed: false } : null;
};

export const listLearningEvents = async (
  db: Db,
  options: { status?: LearningEventStatus; limit?: number; since?: string } = {},
): Promise<LearningEvent[]> => {
  const { rows } = await db.query<LearningEventRow>(
    `SELECT ${COLUMNS} FROM learning_events
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::timestamptz IS NULL OR captured_at >= $2)
     ORDER BY captured_at DESC
     LIMIT $3`,
    [options.status ?? null, options.since ?? null, Math.min(options.limit ?? 50, 200)],
  );
  return rows.map(toDomain);
};
