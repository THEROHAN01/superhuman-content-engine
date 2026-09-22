import type { Job, JobStatus } from '@sce/schemas';
import { job as jobSchema } from '@sce/schemas';
import type { Db } from '../pool.js';
import { withTransaction } from '../pool.js';

const COLUMNS = `id, job_type, status, dedupe_key, payload, run_after, attempts, max_attempts,
  last_error, locked_at, locked_by, correlation_id, created_at, updated_at`;

const toDomain = (row: unknown): Job => jobSchema.parse(row);

export interface EnqueueJob {
  id: string;
  job_type: string;
  dedupe_key: string;
  payload?: Record<string, unknown>;
  run_after?: string;
  max_attempts?: number;
  correlation_id: string;
}

/**
 * Enqueues work, or returns the job already queued for the same key.
 *
 * The unique index covers only `pending` and `running` rows, so the same work can legitimately run
 * again tomorrow while a duplicate enqueue today is a no-op.
 */
export const enqueueJob = async (
  db: Db,
  input: EnqueueJob,
): Promise<{ job: Job; enqueued: boolean }> => {
  const { rows } = await db.query(
    `INSERT INTO jobs (id, job_type, dedupe_key, payload, run_after, max_attempts, correlation_id)
     VALUES ($1,$2,$3,$4::jsonb,COALESCE($5, now()),COALESCE($6, 5),$7)
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.job_type,
      input.dedupe_key,
      JSON.stringify(input.payload ?? {}),
      input.run_after ?? null,
      input.max_attempts ?? null,
      input.correlation_id,
    ],
  );

  if (rows[0]) return { job: toDomain(rows[0]), enqueued: true };

  const { rows: existing } = await db.query(
    `SELECT ${COLUMNS} FROM jobs
     WHERE job_type = $1 AND dedupe_key = $2 AND status IN ('pending','running')`,
    [input.job_type, input.dedupe_key],
  );
  if (!existing[0]) throw new Error('job insert conflicted but no outstanding job was found');
  return { job: toDomain(existing[0]), enqueued: false };
};

/**
 * Claims one due job for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe: each transaction takes a different
 * row instead of blocking on the same one, and a crashed worker's row stays claimed until the
 * stale-lock sweep releases it.
 */
export const claimJob = async (db: Db, workerId: string): Promise<Job | null> =>
  withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE status = 'pending' AND run_after <= now()
       ORDER BY run_after
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (!rows[0]) return null;

    const { rows: claimed } = await client.query(
      `UPDATE jobs
         SET status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [rows[0].id, workerId],
    );
    return toDomain(claimed[0]);
  });

export const completeJob = async (db: Db, id: string): Promise<void> => {
  await db.query(
    `UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, last_error = NULL
     WHERE id = $1 AND status = 'running'`,
    [id],
  );
};

/**
 * Records a failure. Below the attempt budget the job is rescheduled with backoff; at the budget
 * it becomes `dead` - visible, not silently retried forever.
 */
export const failJob = async (
  db: Db,
  id: string,
  error: string,
  options: { retryDelayMs?: number } = {},
): Promise<JobStatus> => {
  const { rows } = await db.query<{ status: JobStatus }>(
    `UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           run_after = now() + make_interval(secs => $3::double precision),
           locked_at = NULL,
           locked_by = NULL,
           last_error = $2
     WHERE id = $1
     RETURNING status`,
    [id, error.slice(0, 2000), (options.retryDelayMs ?? 30_000) / 1000],
  );
  return rows[0]?.status ?? 'failed';
};

/** Releases jobs whose worker died mid-run, so the work is not lost. */
export const releaseStaleJobs = async (db: Db, olderThanMs: number): Promise<number> => {
  const { rowCount } = await db.query(
    `UPDATE jobs
       SET status = 'pending', locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, 'released after a stale lock')
     WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1::double precision)`,
    [olderThanMs / 1000],
  );
  return rowCount ?? 0;
};

export const listJobs = async (
  db: Db,
  options: { status?: JobStatus; jobType?: string; limit?: number } = {},
): Promise<Job[]> => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM jobs
     WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR job_type = $2)
     ORDER BY run_after DESC
     LIMIT $3`,
    [options.status ?? null, options.jobType ?? null, Math.min(options.limit ?? 50, 200)],
  );
  return rows.map(toDomain);
};
