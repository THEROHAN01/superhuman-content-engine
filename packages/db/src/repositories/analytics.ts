import type { AnalyticsEvent, MetricWindow, NormalizedMetrics, Platform } from '@sce/schemas';
import { analyticsEvent as analyticsEventSchema } from '@sce/schemas';
import type { Db } from '../pool.js';

const COLUMNS = `id, publication_id, content_item_id, learning_event_id, platform, metric_window,
  collected_for, collected_at, provider, metrics, raw_payload, created_at, updated_at`;

const toDomain = (row: unknown): AnalyticsEvent => analyticsEventSchema.parse(row);

export interface InsertAnalyticsEvent {
  id: string;
  publication_id: string;
  content_item_id: string;
  learning_event_id: string;
  platform: Platform;
  metric_window: MetricWindow;
  collected_for: string;
  provider: string;
  metrics: NormalizedMetrics;
  raw_payload: Record<string, unknown> | null;
}

/**
 * Records one collection.
 *
 * `(publication_id, metric_window, collected_for)` is unique, so collecting twice for the same day
 * updates the numbers rather than accumulating rows. Updating (not ignoring) is the right choice
 * here: metrics genuinely change during a day, and the collection is identified by the day it
 * describes, not by the moment it ran.
 */
export const upsertAnalyticsEvent = async (
  db: Db,
  input: InsertAnalyticsEvent,
): Promise<{ event: AnalyticsEvent; inserted: boolean }> => {
  const { rows } = await db.query<{ inserted: boolean } & Record<string, unknown>>(
    `INSERT INTO analytics_events
       (id, publication_id, content_item_id, learning_event_id, platform, metric_window,
        collected_for, provider, metrics, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
     ON CONFLICT (publication_id, metric_window, collected_for) DO UPDATE
       SET metrics = EXCLUDED.metrics,
           raw_payload = EXCLUDED.raw_payload,
           provider = EXCLUDED.provider,
           collected_at = now()
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [
      input.id,
      input.publication_id,
      input.content_item_id,
      input.learning_event_id,
      input.platform,
      input.metric_window,
      input.collected_for,
      input.provider,
      JSON.stringify(input.metrics),
      input.raw_payload ? JSON.stringify(input.raw_payload) : null,
    ],
  );

  const row = rows[0]!;
  return { event: toDomain(row), inserted: row.inserted === true };
};

export const listAnalyticsForPublication = async (
  db: Db,
  publicationId: string,
): Promise<AnalyticsEvent[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM analytics_events WHERE publication_id = $1 ORDER BY collected_for, metric_window`,
    [publicationId],
  );
  return rows.map(toDomain);
};

export const listAnalyticsForItem = async (db: Db, itemId: string): Promise<AnalyticsEvent[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM analytics_events WHERE content_item_id = $1 ORDER BY collected_at DESC`,
    [itemId],
  );
  return rows.map(toDomain);
};

/** The most recent collection per publication, which is what reporting reads. */
export const latestAnalyticsSince = async (db: Db, since: string): Promise<AnalyticsEvent[]> => {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (publication_id, metric_window) ${COLUMNS}
     FROM analytics_events
     WHERE collected_at >= $1
     ORDER BY publication_id, metric_window, collected_at DESC`,
    [since],
  );
  return rows.map(toDomain);
};
