import { jobs, operations, publications } from '@sce/db';
import type { ServiceContext } from './context.js';

/**
 * System health.
 *
 * Two different questions, deliberately separated:
 *   - **dependencies**: can this process do its job right now?
 *   - **pipeline**: is work moving, or is something quietly stuck?
 *
 * The second is the one that actually bites: every dependency can be green while content sits in
 * `pending_approval` for a week or publications retry forever.
 */
export interface HealthCheck {
  ok: boolean;
  detail: string;
}

export interface StalledItem {
  kind: string;
  count: number;
  oldest_hours: number | null;
  detail: string;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Record<string, HealthCheck>;
  stalled: StalledItem[];
  recent_errors: Array<{ code: string; count: number; last_seen: string }>;
  config: Record<string, string>;
}

/** How long each state may sit before it counts as stuck. */
export const STALL_THRESHOLDS_HOURS = {
  learning_unprocessed: 24,
  draft_ungated: 12,
  awaiting_approval: 72,
  publication_retrying: 6,
  publication_overdue: 2,
  job_dead: 0,
} as const;

export const checkSystemHealth = async (ctx: ServiceContext): Promise<SystemHealth> => {
  const checks: Record<string, HealthCheck> = {};

  const started = Date.now();
  try {
    await ctx.db.query('SELECT 1');
    checks['database'] = { ok: true, detail: `${Date.now() - started}ms` };
  } catch (error) {
    checks['database'] = {
      ok: false,
      detail: error instanceof Error ? error.message : 'unreachable',
    };
  }

  // Migrations matter for health: a process running against an older schema fails in confusing
  // ways much later.
  try {
    const { rows } = await ctx.db.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    checks['migrations'] = {
      ok: rows.length > 0,
      detail: rows[0]?.version ?? 'no migrations applied',
    };
  } catch {
    checks['migrations'] = { ok: false, detail: 'schema_migrations is unreadable' };
  }

  const stalled: StalledItem[] = [];
  const addStall = async (
    kind: string,
    sql: string,
    params: unknown[],
    detail: string,
  ): Promise<void> => {
    const { rows } = await ctx.db.query<{ count: number; oldest_hours: string | null }>(
      sql,
      params,
    );
    const count = rows[0]?.count ?? 0;
    if (count > 0) {
      stalled.push({
        kind,
        count,
        oldest_hours: rows[0]?.oldest_hours
          ? Number(Number(rows[0].oldest_hours).toFixed(1))
          : null,
        detail,
      });
    }
  };

  if (checks['database']?.ok) {
    await addStall(
      'learning_unprocessed',
      `SELECT count(*)::int AS count, max(EXTRACT(EPOCH FROM (now() - captured_at)) / 3600.0) AS oldest_hours
       FROM learning_events
       WHERE status = 'received' AND captured_at < now() - make_interval(hours => $1::int)`,
      [STALL_THRESHOLDS_HOURS.learning_unprocessed],
      'captured but never normalized or classified',
    );
    await addStall(
      'draft_ungated',
      `SELECT count(*)::int AS count, max(EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0) AS oldest_hours
       FROM content_items
       WHERE status = 'draft' AND created_at < now() - make_interval(hours => $1::int)`,
      [STALL_THRESHOLDS_HOURS.draft_ungated],
      'generated but never sent through the quality gate',
    );
    await addStall(
      'awaiting_approval',
      `SELECT count(*)::int AS count, max(EXTRACT(EPOCH FROM (now() - updated_at)) / 3600.0) AS oldest_hours
       FROM content_items
       WHERE status = 'pending_approval' AND updated_at < now() - make_interval(hours => $1::int)`,
      [STALL_THRESHOLDS_HOURS.awaiting_approval],
      'waiting for a human decision',
    );
    await addStall(
      'publication_retrying',
      `SELECT count(*)::int AS count, max(EXTRACT(EPOCH FROM (now() - updated_at)) / 3600.0) AS oldest_hours
       FROM publications
       WHERE status = 'retry_pending' AND updated_at < now() - make_interval(hours => $1::int)`,
      [STALL_THRESHOLDS_HOURS.publication_retrying],
      'publication retrying without succeeding',
    );
    await addStall(
      'publication_overdue',
      `SELECT count(*)::int AS count, max(EXTRACT(EPOCH FROM (now() - scheduled_at)) / 3600.0) AS oldest_hours
       FROM publications
       WHERE status = 'scheduled' AND scheduled_at < now() - make_interval(hours => $1::int)`,
      [STALL_THRESHOLDS_HOURS.publication_overdue],
      'scheduled slot passed but never confirmed published',
    );
    await addStall(
      'job_dead',
      `SELECT count(*)::int AS count, max(EXTRACT(EPOCH FROM (now() - updated_at)) / 3600.0) AS oldest_hours
       FROM jobs WHERE status = 'dead'`,
      [],
      'jobs that exhausted their retries',
    );
  }

  const recentErrors = checks['database']?.ok
    ? (
        await ctx.db.query<{ code: string; count: number; last_seen: string }>(
          `SELECT code, count(*)::int AS count, max(occurred_at) AS last_seen
           FROM error_events
           WHERE occurred_at > now() - interval '24 hours'
           GROUP BY code
           ORDER BY count DESC
           LIMIT 10`,
        )
      ).rows
    : [];

  const dependenciesOk = Object.values(checks).every((check) => check.ok);
  const status: SystemHealth['status'] = !dependenciesOk
    ? 'unhealthy'
    : stalled.length > 0
      ? 'degraded'
      : 'healthy';

  return {
    status,
    checks,
    stalled,
    recent_errors: recentErrors,
    config: {
      publish_mode: ctx.env.PUBLISH_MODE,
      llm_provider: ctx.env.LLM_PROVIDER,
      research_provider: ctx.env.RESEARCH_PROVIDER,
      publishing_provider: ctx.env.PUBLISHING_PROVIDER,
      telegram_provider: ctx.env.TELEGRAM_PROVIDER,
      timezone: ctx.env.TZ,
    },
  };
};

export interface RecoverySweepResult {
  released_jobs: number;
  requeued_publications: number;
  dead_letters: number;
}

/**
 * Recovery sweep.
 *
 * Releases work abandoned by a crashed worker and gives retryable publications another chance,
 * while anything that has exhausted its budget is left dead and visible rather than retried
 * forever. Safe to run repeatedly - every step is a conditional update.
 */
export const sweepStuckWork = async (
  ctx: ServiceContext,
  options: { staleLockMs?: number; maxPublicationAttempts?: number } = {},
): Promise<RecoverySweepResult> => {
  const released = await jobs.releaseStaleJobs(ctx.db, options.staleLockMs ?? 10 * 60_000);
  const maxAttempts = options.maxPublicationAttempts ?? ctx.env.WORKER_MAX_ATTEMPTS;

  // Publications still inside their attempt budget go back to pending so the next publish run
  // picks them up; the claimed row means this can never create a second post.
  const { rowCount: requeued } = await ctx.db.query(
    `UPDATE publications
       SET status = 'pending'
     WHERE status = 'retry_pending' AND attempts < $1`,
    [maxAttempts],
  );

  const { rows: exhausted } = await ctx.db.query<{
    id: string;
    content_item_id: string;
    last_error: string | null;
  }>(
    `UPDATE publications
       SET status = 'failed'
     WHERE status = 'retry_pending' AND attempts >= $1
     RETURNING id, content_item_id, last_error`,
    [maxAttempts],
  );

  for (const row of exhausted) {
    await operations.recordError(ctx.db, {
      workflow: 'system_sweep_v1',
      step: 'dead_letter',
      kind: 'permanent',
      code: 'E_PUBLISH_EXHAUSTED',
      message: `publication ${row.id} gave up after ${maxAttempts} attempts: ${row.last_error ?? 'no error recorded'}`,
      correlationId: `cor_sweep_${row.id}`,
      subjectId: row.content_item_id,
    });
  }

  if (released > 0 || (requeued ?? 0) > 0 || exhausted.length > 0) {
    ctx.logger.warn(
      {
        released_jobs: released,
        requeued_publications: requeued ?? 0,
        dead_letters: exhausted.length,
      },
      'recovery sweep moved stuck work',
    );
  }

  return {
    released_jobs: released,
    requeued_publications: requeued ?? 0,
    dead_letters: exhausted.length,
  };
};

/** Publications whose scheduled slot has passed; the worker confirms them as published. */
export const dueScheduledPublications = async (ctx: ServiceContext, limit = 50) => {
  const scheduled = await publications.listPublications(ctx.db, { status: 'scheduled', limit });
  const now = ctx.clock().getTime();
  return scheduled.filter((publication) => new Date(publication.scheduled_at).getTime() <= now);
};
