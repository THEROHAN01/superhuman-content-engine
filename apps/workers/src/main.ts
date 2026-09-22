/**
 * Worker entrypoint.
 *
 * Time-based work only: it claims jobs from the durable queue and runs them. Business rules stay in
 * `@sce/core`, so a job handler is a thin translation from payload to service call.
 */
import { createPool } from '@sce/db';
import { createLogger, getEnv, systemClock, EnvError } from '@sce/utils';
import type { ServiceContext } from '@sce/core';
import { runWorker, scheduleRecurring, type JobHandler } from './runtime.js';
import { collectAnalyticsJob } from './jobs/collect-analytics.js';

const HANDLERS: Record<string, JobHandler> = {
  collect_analytics: collectAnalyticsJob,
};

const main = async (): Promise<void> => {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(78);
  }

  const logger = createLogger({ name: 'workers', level: env.LOG_LEVEL });
  const db = createPool({ applicationName: 'sce-workers' });
  const ctx: ServiceContext = { db, env, logger, clock: systemClock };
  const signal = { stopped: false };

  const shutdown = (reason: string): void => {
    logger.info({ reason }, 'worker shutting down');
    signal.stopped = true;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (env.ENABLE_SCHEDULED_JOBS) {
    // Enqueue today's collection at startup; the dedupe key makes repeated starts harmless.
    const today = new Date().toISOString().slice(0, 10);
    const scheduled = await scheduleRecurring(ctx, {
      jobType: 'collect_analytics',
      periodKey: today,
      payload: { window: '24h', collected_for: today },
    });
    logger.info({ ...scheduled, period: today }, 'scheduled analytics collection');
  }

  logger.info(
    { handlers: Object.keys(HANDLERS), poll_ms: env.WORKER_POLL_INTERVAL_MS },
    'worker started',
  );
  await runWorker(ctx, { handlers: HANDLERS }, logger, signal);

  await db.end();
  logger.info('worker stopped');
};

void main();
