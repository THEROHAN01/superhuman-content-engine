import type { Platform, Publication, PublicationStatus } from '@sce/schemas';
import { publication as publicationSchema } from '@sce/schemas';
import type { Db } from '../pool.js';

const COLUMNS = `id, content_item_id, learning_event_id, platform, status, idempotency_key, provider,
  external_id, external_url, scheduled_at, published_at, dry_run, attempts, last_error,
  provider_metadata, correlation_id, created_at, updated_at`;

const toDomain = (row: unknown): Publication => publicationSchema.parse(row);

export interface InsertPublication {
  id: string;
  content_item_id: string;
  learning_event_id: string;
  platform: Platform;
  idempotency_key: string;
  provider: string;
  scheduled_at: string;
  dry_run: boolean;
  correlation_id: string;
}

/**
 * Claims the right to publish one item into one slot.
 *
 * The unique `idempotency_key` is what makes duplicate publication impossible: the second caller
 * gets the first caller's row back rather than a second row, even if both are mid-flight. Nothing
 * is sent to a provider until this row exists.
 */
export const claimPublication = async (
  db: Db,
  input: InsertPublication,
): Promise<{ publication: Publication; claimed: boolean }> => {
  const { rows } = await db.query(
    `INSERT INTO publications
       (id, content_item_id, learning_event_id, platform, status, idempotency_key, provider,
        scheduled_at, dry_run, correlation_id)
     VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.content_item_id,
      input.learning_event_id,
      input.platform,
      input.idempotency_key,
      input.provider,
      input.scheduled_at,
      input.dry_run,
      input.correlation_id,
    ],
  );

  if (rows[0]) return { publication: toDomain(rows[0]), claimed: true };

  const existing = await findByIdempotencyKey(db, input.idempotency_key);
  if (!existing) throw new Error('publication insert conflicted but no existing row was found');
  return { publication: existing, claimed: false };
};

export const findByIdempotencyKey = async (db: Db, key: string): Promise<Publication | null> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM publications WHERE idempotency_key = $1`,
    [key],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

export const findPublication = async (db: Db, id: string): Promise<Publication | null> => {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM publications WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : null;
};

/** Status transitions. A publication never moves backwards, and `published` is terminal. */
const ALLOWED_FROM: Record<PublicationStatus, readonly PublicationStatus[]> = {
  pending: [],
  scheduled: ['pending', 'retry_pending'],
  published: ['pending', 'scheduled', 'retry_pending'],
  retry_pending: ['pending', 'scheduled', 'retry_pending'],
  failed: ['pending', 'scheduled', 'retry_pending'],
  cancelled: ['pending', 'scheduled', 'retry_pending'],
};

export interface PublicationPatch {
  external_id?: string | null;
  external_url?: string | null;
  published_at?: string | null;
  last_error?: string | null;
  provider_metadata?: Record<string, unknown> | null;
  incrementAttempts?: boolean;
}

export const setPublicationStatus = async (
  db: Db,
  id: string,
  status: PublicationStatus,
  patch: PublicationPatch = {},
): Promise<{ publication: Publication; changed: boolean } | null> => {
  const { rows } = await db.query(
    `UPDATE publications SET
       status = $3,
       external_id = COALESCE($4, external_id),
       external_url = COALESCE($5, external_url),
       published_at = COALESCE($6, published_at),
       last_error = CASE WHEN $7::text IS NULL THEN last_error WHEN $7 = '' THEN NULL ELSE $7 END,
       provider_metadata = COALESCE($8::jsonb, provider_metadata),
       attempts = attempts + CASE WHEN $9 THEN 1 ELSE 0 END
     WHERE id = $1 AND status = ANY($2::text[])
     RETURNING ${COLUMNS}`,
    [
      id,
      ALLOWED_FROM[status],
      status,
      patch.external_id ?? null,
      patch.external_url ?? null,
      patch.published_at ?? null,
      patch.last_error ?? null,
      patch.provider_metadata ? JSON.stringify(patch.provider_metadata) : null,
      patch.incrementAttempts === true,
    ],
  );

  if (rows[0]) return { publication: toDomain(rows[0]), changed: true };
  const current = await findPublication(db, id);
  return current ? { publication: current, changed: false } : null;
};

export const listPublications = async (
  db: Db,
  options: { status?: PublicationStatus; limit?: number } = {},
): Promise<Publication[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM publications
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY scheduled_at DESC
     LIMIT $2`,
    [options.status ?? null, Math.min(options.limit ?? 50, 200)],
  );
  return rows.map(toDomain);
};

export const listPublicationsForItem = async (db: Db, itemId: string): Promise<Publication[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM publications WHERE content_item_id = $1 ORDER BY created_at`,
    [itemId],
  );
  return rows.map(toDomain);
};
