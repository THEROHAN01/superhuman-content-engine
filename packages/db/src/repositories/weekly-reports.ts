import type { WeeklyReport, WeeklyReportBody, WeeklyReportStatus } from '@sce/schemas';
import { weeklyReport as weeklyReportSchema } from '@sce/schemas';
import type { Db } from '../pool.js';

const COLUMNS = `id, period_start, period_end, timezone, period_key, status, generator_version,
  body, delivered_at, delivery_error, correlation_id, created_at, updated_at`;

const toDomain = (row: unknown): WeeklyReport => weeklyReportSchema.parse(row);

export interface UpsertWeeklyReport {
  id: string;
  period_start: string;
  period_end: string;
  timezone: string;
  period_key: string;
  generator_version: string;
  body: WeeklyReportBody;
  correlation_id: string;
}

/**
 * Stores this week's report, replacing an earlier generation for the same week and generator
 * version. Regenerating mid-week is normal (more data has arrived); accumulating five
 * near-identical reports is not.
 */
export const upsertWeeklyReport = async (
  db: Db,
  input: UpsertWeeklyReport,
): Promise<{ report: WeeklyReport; inserted: boolean }> => {
  const { rows } = await db.query<{ inserted: boolean } & Record<string, unknown>>(
    `INSERT INTO weekly_reports
       (id, period_start, period_end, timezone, period_key, generator_version, body, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (period_key, generator_version) DO UPDATE
       SET body = EXCLUDED.body,
           period_start = EXCLUDED.period_start,
           period_end = EXCLUDED.period_end,
           status = 'generated'
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [
      input.id,
      input.period_start,
      input.period_end,
      input.timezone,
      input.period_key,
      input.generator_version,
      JSON.stringify(input.body),
      input.correlation_id,
    ],
  );

  const row = rows[0]!;
  return { report: toDomain(row), inserted: row.inserted === true };
};

export const markReportDelivered = async (
  db: Db,
  id: string,
  outcome: { delivered: boolean; error?: string },
): Promise<WeeklyReport | null> => {
  const status: WeeklyReportStatus = outcome.delivered ? 'delivered' : 'failed';
  const { rows } = await db.query(
    `UPDATE weekly_reports
       SET status = $2,
           delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
           delivery_error = $3
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, status, outcome.error?.slice(0, 2000) ?? null],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

export const findWeeklyReport = async (db: Db, id: string): Promise<WeeklyReport | null> => {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM weekly_reports WHERE id = $1`, [id]);
  return rows[0] ? toDomain(rows[0]) : null;
};

export const findReportForPeriod = async (
  db: Db,
  periodKey: string,
  generatorVersion: string,
): Promise<WeeklyReport | null> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM weekly_reports WHERE period_key = $1 AND generator_version = $2`,
    [periodKey, generatorVersion],
  );
  return rows[0] ? toDomain(rows[0]) : null;
};

/** History stays available: reports are never deleted or rewritten in place by a later week. */
export const listWeeklyReports = async (db: Db, limit = 20): Promise<WeeklyReport[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM weekly_reports ORDER BY period_start DESC LIMIT $1`,
    [Math.min(limit, 100)],
  );
  return rows.map(toDomain);
};
