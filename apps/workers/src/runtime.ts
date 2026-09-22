import { jobs } from '@sce/db';
import { newCorrelationId, newId, type Logger } from '@sce/utils';
import type { ServiceContext } from '@sce/core';

/**
 * A small durable job runner on top of PostgreSQL.
 *
 * PostgreSQL rather than Redis because the jobs must survive a restart and because
 * `FOR UPDATE SKIP LOCKED` already gives exactly the claim semantics a queue needs - adding a
 * second datastore for this would mean two sources of truth about what has run.
 */
export type JobHandler = (
  ctx: ServiceContext,
  payload: Record<string, unknown>,
) => Promise<unknown>;

export interface RunnerOptions {
  handlers: Record<string, JobHandler>;
  workerId?: string;
  pollIntervalMs?: number;
  staleLockMs?: number;
  /** Stop after this many idle polls; used by tests and one-shot runs. */
  maxIdlePolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOnceResult {
  claimed: boolean;
  jobType?: string;
  outcome?: 'succeeded' | 'retry' | 'dead';
  error?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Claims and runs at most one job. Returns what happened, so callers can drive a loop or a test. */
export const runOnce = async (
  ctx: ServiceContext,
  options: RunnerOptions,
  log: Logger,
): Promise<RunOnceResult> => {
  const workerId = options.workerId ?? `worker-${process.pid}`;
  const job = await jobs.claimJob(ctx.db, workerId);
  if (!job) return { claimed: false };

  const handler = options.handlers[job.job_type];
  if (!handler) {
    // An unknown job type is a deployment mistake, not a transient fault: fail it immediately
    // rather than retrying something no code can handle.
    await jobs.failJob(ctx.db, job.id, `no handler for job type '${job.job_type}'`, {
      retryDelayMs: 0,
    });
    log.error({ job_id: job.id, job_type: job.job_type }, 'no handler registered for job type');
    return { claimed: true, jobType: job.job_type, outcome: 'dead', error: 'no handler' };
  }

  try {
    const result = await handler(ctx, job.payload);
    await jobs.completeJob(ctx.db, job.id);
    log.info({ job_id: job.id, job_type: job.job_type, result }, 'job completed');
    return { claimed: true, jobType: job.job_type, outcome: 'succeeded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown job failure';
    // Backoff grows with attempts so a persistently failing job does not spin.
    const status = await jobs.failJob(ctx.db, job.id, message, {
      retryDelayMs: Math.min(60_000 * job.attempts, 15 * 60_000),
    });
    log.warn({ job_id: job.id, job_type: job.job_type, status, err: message }, 'job failed');
    return {
      claimed: true,
      jobType: job.job_type,
      outcome: status === 'dead' ? 'dead' : 'retry',
      error: message,
    };
  }
};

export const runWorker = async (
  ctx: ServiceContext,
  options: RunnerOptions,
  log: Logger,
  signal: { stopped: boolean },
): Promise<void> => {
  const sleep = options.sleep ?? defaultSleep;
  const pollInterval = options.pollIntervalMs ?? ctx.env.WORKER_POLL_INTERVAL_MS;
  const staleLockMs = options.staleLockMs ?? 10 * 60_000;
  let idlePolls = 0;

  while (!signal.stopped) {
    const released = await jobs.releaseStaleJobs(ctx.db, staleLockMs);
    if (released > 0) log.warn({ released }, 'released jobs from a stale worker lock');

    const result = await runOnce(ctx, options, log);
    if (result.claimed) {
      idlePolls = 0;
      continue; // drain the queue before sleeping
    }

    idlePolls += 1;
    if (options.maxIdlePolls !== undefined && idlePolls >= options.maxIdlePolls) return;
    await sleep(pollInterval);
  }
};

/** Schedules recurring work by enqueuing a job whose dedupe key contains the period it covers. */
export const scheduleRecurring = async (
  ctx: ServiceContext,
  input: {
    jobType: string;
    periodKey: string;
    payload?: Record<string, unknown>;
    runAfter?: string;
  },
): Promise<{ enqueued: boolean; jobId: string }> => {
  const { job, enqueued } = await jobs.enqueueJob(ctx.db, {
    id: newId('job'),
    job_type: input.jobType,
    // The period is part of the key, so "collect today's analytics" can be enqueued repeatedly
    // without piling up, and tomorrow's run is a different job.
    dedupe_key: `${input.jobType}:${input.periodKey}`,
    payload: input.payload ?? {},
    ...(input.runAfter ? { run_after: input.runAfter } : {}),
    correlation_id: newCorrelationId(),
  });
  return { enqueued, jobId: job.id };
};
