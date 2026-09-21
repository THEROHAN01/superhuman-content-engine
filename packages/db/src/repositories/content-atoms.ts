import type { ContentAtom, ContentAtomStatus, EvidenceStatus } from '@sce/schemas';
import { contentAtom as contentAtomSchema } from '@sce/schemas';
import type { Db } from '../pool.js';

const COLUMNS = `id, schema_version, learning_event_id, status, title, kind, primary_topic,
  secondary_topics, entities, body, evidence_status, confidence, error, generator_version,
  atomized_at, created_at, updated_at`;

const toDomain = (row: unknown): ContentAtom => contentAtomSchema.parse(row);

export interface InsertContentAtom {
  id: string;
  learning_event_id: string;
  status: ContentAtomStatus;
  title: string;
  kind: ContentAtom['kind'];
  primary_topic: ContentAtom['primary_topic'];
  secondary_topics: string[];
  entities: string[];
  body: ContentAtom['body'];
  evidence_status: EvidenceStatus;
  confidence: number;
  generator_version: string;
}

/**
 * Creates the atom for a learning event, or returns the existing one.
 *
 * One atom per event is a database guarantee (`content_atoms_learning_event_key`), so replaying
 * the classification pipeline cannot fork an event into two canonical objects.
 */
export const upsertContentAtom = async (
  db: Db,
  input: InsertContentAtom,
): Promise<{ atom: ContentAtom; inserted: boolean }> => {
  const { rows } = await db.query(
    `INSERT INTO content_atoms
       (id, learning_event_id, status, title, kind, primary_topic, secondary_topics, entities,
        body, evidence_status, confidence, generator_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
     ON CONFLICT (learning_event_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.learning_event_id,
      input.status,
      input.title,
      input.kind,
      input.primary_topic,
      input.secondary_topics,
      input.entities,
      JSON.stringify(input.body),
      input.evidence_status,
      input.confidence,
      input.generator_version,
    ],
  );

  if (rows[0]) return { atom: toDomain(rows[0]), inserted: true };

  const existing = await findAtomByLearningEvent(db, input.learning_event_id);
  if (!existing) throw new Error('atom insert conflicted but no existing atom was found');
  return { atom: existing, inserted: false };
};

export const findAtomByLearningEvent = async (
  db: Db,
  learningEventId: string,
): Promise<ContentAtom | null> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM content_atoms WHERE learning_event_id = $1`,
    [learningEventId],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

export const findAtom = async (db: Db, id: string): Promise<ContentAtom | null> => {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM content_atoms WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : null;
};

export const updateAtom = async (
  db: Db,
  id: string,
  patch: Partial<
    Pick<
      ContentAtom,
      'status' | 'body' | 'evidence_status' | 'confidence' | 'error' | 'atomized_at'
    >
  >,
): Promise<ContentAtom | null> => {
  const { rows } = await db.query(
    `UPDATE content_atoms SET
       status = COALESCE($2, status),
       body = COALESCE($3::jsonb, body),
       evidence_status = COALESCE($4, evidence_status),
       confidence = COALESCE($5, confidence),
       error = CASE WHEN $6::text IS NULL THEN error ELSE $6 END,
       atomized_at = COALESCE($7, atomized_at)
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      patch.status ?? null,
      patch.body ? JSON.stringify(patch.body) : null,
      patch.evidence_status ?? null,
      patch.confidence ?? null,
      patch.error ?? null,
      patch.atomized_at ?? null,
    ],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

/** Recent candidates for near-duplicate comparison: normalized text of the last N events. */
export const recentNormalizedEvents = async (
  db: Db,
  options: { excludeId: string; limit?: number },
): Promise<Array<{ id: string; canonical: string }>> => {
  const { rows } = await db.query<{ id: string; normalized_text: string | null; raw_text: string }>(
    `SELECT id, normalized_text, raw_text FROM learning_events
     WHERE id <> $1 AND duplicate_of IS NULL AND status <> 'failed'
     ORDER BY captured_at DESC
     LIMIT $2`,
    [options.excludeId, Math.min(options.limit ?? 200, 500)],
  );
  return rows.map((row) => ({ id: row.id, canonical: row.normalized_text ?? row.raw_text }));
};
