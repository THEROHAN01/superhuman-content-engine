import type {
  ContentItem,
  ContentItemStatus,
  ContentFormat,
  QualityGateResult,
} from '@sce/schemas';
import { contentItem as contentItemSchema } from '@sce/schemas';
import type { Db } from '../pool.js';
import { withTransaction } from '../pool.js';

const COLUMNS = `id, content_idea_id, content_atom_id, learning_event_id, version, status, platform,
  format, draft, quality_gate, prompt_id, prompt_version, model, superseded_by, error,
  correlation_id, created_at, updated_at`;

const toDomain = (row: unknown): ContentItem => contentItemSchema.parse(row);

export interface InsertContentItem {
  id: string;
  content_idea_id: string;
  content_atom_id: string;
  learning_event_id: string;
  platform: ContentItem['platform'];
  format: ContentFormat;
  draft: ContentItem['draft'];
  prompt_id: string;
  prompt_version: string;
  model: string;
  correlation_id: string;
}

/**
 * Creates the next version of a draft for (idea, format).
 *
 * Regeneration never overwrites: the new row gets `version = max + 1` and the previous version is
 * marked `superseded`, so the history of what was written - and what a human approved - stays
 * intact. The whole thing runs in one transaction so a crash cannot leave two live versions.
 */
export const insertContentItemVersion = async (
  db: Db,
  input: InsertContentItem,
): Promise<{ item: ContentItem; supersededId: string | null }> =>
  withTransaction(db, async (client) => {
    const { rows: previous } = await client.query<{
      id: string;
      version: number;
      status: ContentItemStatus;
    }>(
      `SELECT id, version, status FROM content_items
       WHERE content_idea_id = $1 AND format = $2
       ORDER BY version DESC
       LIMIT 1
       FOR UPDATE`,
      [input.content_idea_id, input.format],
    );

    const latest = previous[0];
    const version = (latest?.version ?? 0) + 1;

    const { rows } = await client.query(
      `INSERT INTO content_items
         (id, content_idea_id, content_atom_id, learning_event_id, version, status, platform,
          format, draft, prompt_id, prompt_version, model, correlation_id)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8::jsonb,$9,$10,$11,$12)
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.content_idea_id,
        input.content_atom_id,
        input.learning_event_id,
        version,
        input.platform,
        input.format,
        JSON.stringify(input.draft),
        input.prompt_id,
        input.prompt_version,
        input.model,
        input.correlation_id,
      ],
    );

    let supersededId: string | null = null;
    // A published version stays published; only unpublished work is superseded.
    if (latest && latest.status !== 'published') {
      await client.query(
        `UPDATE content_items SET status = 'superseded', superseded_by = $2 WHERE id = $1`,
        [latest.id, input.id],
      );
      supersededId = latest.id;
    }

    return { item: toDomain(rows[0]), supersededId };
  });

export const findContentItem = async (db: Db, id: string): Promise<ContentItem | null> => {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM content_items WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : null;
};

export const listItemsForIdea = async (db: Db, ideaId: string): Promise<ContentItem[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM content_items WHERE content_idea_id = $1 ORDER BY format, version`,
    [ideaId],
  );
  return rows.map(toDomain);
};

export const listContentItems = async (
  db: Db,
  options: { status?: ContentItemStatus; limit?: number } = {},
): Promise<ContentItem[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM content_items
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC
     LIMIT $2`,
    [options.status ?? null, Math.min(options.limit ?? 50, 200)],
  );
  return rows.map(toDomain);
};

/** Status transitions allowed for a draft. Publishing states are added by later milestones. */
const ALLOWED_FROM: Record<ContentItemStatus, readonly ContentItemStatus[]> = {
  draft: [],
  gated: ['draft', 'gated'],
  pending_approval: ['gated'],
  approved: ['pending_approval'],
  rejected: ['pending_approval', 'gated'],
  scheduled: ['approved'],
  published: ['scheduled', 'approved'],
  superseded: ['draft', 'gated', 'pending_approval', 'rejected'],
  failed: ['draft', 'gated', 'pending_approval', 'approved', 'scheduled'],
};

export const setContentItemStatus = async (
  db: Db,
  id: string,
  status: ContentItemStatus,
  patch: { quality_gate?: QualityGateResult; error?: string | null } = {},
): Promise<{ item: ContentItem; changed: boolean } | null> => {
  const { rows } = await db.query(
    `UPDATE content_items SET
       status = $3,
       quality_gate = COALESCE($4::jsonb, quality_gate),
       error = CASE WHEN $5::text IS NULL THEN error WHEN $5 = '' THEN NULL ELSE $5 END
     WHERE id = $1 AND status = ANY($2::text[])
     RETURNING ${COLUMNS}`,
    [
      id,
      ALLOWED_FROM[status],
      status,
      patch.quality_gate ? JSON.stringify(patch.quality_gate) : null,
      patch.error ?? null,
    ],
  );

  if (rows[0]) return { item: toDomain(rows[0]), changed: true };

  const current = await findContentItem(db, id);
  return current ? { item: current, changed: false } : null;
};
