import type { ContentIdea, ContentIdeaStatus } from '@sce/schemas';
import { contentIdea as contentIdeaSchema } from '@sce/schemas';
import type { Db } from '../pool.js';

const COLUMNS = `id, content_atom_id, learning_event_id, status, angle, title, rationale, audience,
  platforms, formats, hook, evidence_required, dedupe_hash, rejection_reason, score,
  prompt_version, created_at, updated_at`;

const toDomain = (row: unknown): ContentIdea => contentIdeaSchema.parse(row);

export interface InsertContentIdea {
  id: string;
  content_atom_id: string;
  learning_event_id: string;
  status: ContentIdeaStatus;
  angle: ContentIdea['angle'];
  title: string;
  rationale: string;
  audience: string;
  platforms: string[];
  formats: string[];
  hook: string;
  evidence_required: boolean;
  dedupe_hash: string;
  rejection_reason: string | null;
  score: number | null;
  prompt_version: string;
}

/**
 * Inserts an idea, or returns the existing one with the same dedupe hash.
 *
 * `(content_atom_id, dedupe_hash)` is unique, so re-running ideation on the same atom converges
 * instead of growing the idea list without bound.
 */
export const insertContentIdea = async (
  db: Db,
  input: InsertContentIdea,
): Promise<{ idea: ContentIdea; inserted: boolean }> => {
  const { rows } = await db.query(
    `INSERT INTO content_ideas
       (id, content_atom_id, learning_event_id, status, angle, title, rationale, audience,
        platforms, formats, hook, evidence_required, dedupe_hash, rejection_reason, score, prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (content_atom_id, dedupe_hash) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.content_atom_id,
      input.learning_event_id,
      input.status,
      input.angle,
      input.title,
      input.rationale,
      input.audience,
      input.platforms,
      input.formats,
      input.hook,
      input.evidence_required,
      input.dedupe_hash,
      input.rejection_reason,
      input.score,
      input.prompt_version,
    ],
  );

  if (rows[0]) return { idea: toDomain(rows[0]), inserted: true };

  const { rows: existing } = await db.query(
    `SELECT ${COLUMNS} FROM content_ideas WHERE content_atom_id = $1 AND dedupe_hash = $2`,
    [input.content_atom_id, input.dedupe_hash],
  );
  if (!existing[0]) throw new Error('idea insert conflicted but no existing idea was found');
  return { idea: toDomain(existing[0]), inserted: false };
};

export const listIdeasForAtom = async (db: Db, atomId: string): Promise<ContentIdea[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM content_ideas WHERE content_atom_id = $1 ORDER BY score DESC NULLS LAST, created_at`,
    [atomId],
  );
  return rows.map(toDomain);
};

export const findIdea = async (db: Db, id: string): Promise<ContentIdea | null> => {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM content_ideas WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : null;
};

export const listIdeas = async (
  db: Db,
  options: { status?: ContentIdeaStatus; limit?: number } = {},
): Promise<ContentIdea[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM content_ideas
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY score DESC NULLS LAST, created_at DESC
     LIMIT $2`,
    [options.status ?? null, Math.min(options.limit ?? 50, 200)],
  );
  return rows.map(toDomain);
};

export const setIdeaStatus = async (
  db: Db,
  id: string,
  status: ContentIdeaStatus,
  rejectionReason?: string | null,
): Promise<ContentIdea | null> => {
  const { rows } = await db.query(
    `UPDATE content_ideas
       SET status = $2, rejection_reason = COALESCE($3, rejection_reason)
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, status, rejectionReason ?? null],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};
