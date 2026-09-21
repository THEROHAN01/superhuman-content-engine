import type { SourceDocument, SourceType } from '@sce/schemas';
import { sourceDocument as sourceDocumentSchema } from '@sce/schemas';
import type { Db } from '../pool.js';

const COLUMNS = `id, learning_event_id, content_atom_id, title, url, canonical_url, source_type,
  excerpt, summary, retrieved_at, provider, relevance, created_at, updated_at`;

const toDomain = (row: unknown): SourceDocument => sourceDocumentSchema.parse(row);

export interface InsertSourceDocument {
  id: string;
  learning_event_id: string | null;
  content_atom_id: string | null;
  title: string;
  url: string;
  canonical_url: string;
  source_type: SourceType;
  excerpt: string | null;
  summary: string | null;
  provider: string;
  relevance: number | null;
}

/**
 * Attaches evidence to an atom, ignoring a URL that is already attached.
 *
 * Deduplication is by canonical URL and enforced by a unique index, so repeated research runs
 * converge on one row per source instead of accumulating copies.
 */
export const insertSourceDocument = async (
  db: Db,
  input: InsertSourceDocument,
): Promise<{ source: SourceDocument; inserted: boolean }> => {
  const { rows } = await db.query(
    `INSERT INTO source_documents
       (id, learning_event_id, content_atom_id, title, url, canonical_url, source_type, excerpt,
        summary, provider, relevance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.learning_event_id,
      input.content_atom_id,
      input.title,
      input.url,
      input.canonical_url,
      input.source_type,
      input.excerpt,
      input.summary,
      input.provider,
      input.relevance,
    ],
  );

  if (rows[0]) return { source: toDomain(rows[0]), inserted: true };

  const { rows: existing } = await db.query(
    `SELECT ${COLUMNS} FROM source_documents WHERE content_atom_id = $1 AND canonical_url = $2`,
    [input.content_atom_id, input.canonical_url],
  );
  if (!existing[0]) throw new Error('source insert conflicted but no existing source was found');
  return { source: toDomain(existing[0]), inserted: false };
};

export const listSourcesForAtom = async (db: Db, atomId: string): Promise<SourceDocument[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM source_documents WHERE content_atom_id = $1 ORDER BY relevance DESC NULLS LAST, created_at`,
    [atomId],
  );
  return rows.map(toDomain);
};

export const countSourcesForAtom = async (db: Db, atomId: string): Promise<number> => {
  const { rows } = await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM source_documents WHERE content_atom_id = $1',
    [atomId],
  );
  return rows[0]?.count ?? 0;
};
