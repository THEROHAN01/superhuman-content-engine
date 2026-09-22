/**
 * Worker entrypoint.
 *
 * Time-based work only: it claims jobs from the durable queue and runs them. Business rules stay in
 * `@sce/core`, so a job handler is a thin translation from payload to service call.
 */
import { createPool } from '@sce/db';
import { createLogger, getEnv, systemClock, EnvError } from '@sce/utils';
import { isoWeekKey, type ServiceContext } from '@sce/core';
import { runWorker, scheduleRecurring, type JobHandler } from './runtime.js';
import { collectAnalyticsJob } from './jobs/collect-analytics.js';
import { sweepJob } from './jobs/sweep.js';
import { weeklyReportJob } from './jobs/weekly-report.js';

const HANDLERS: Record<string, JobHandler> = {
  collect_analytics: collectAnalyticsJob,
  weekly_report: weeklyReportJob,
  system_sweep: sweepJob,
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

    // One report per ISO week; the period key makes repeated starts harmless.
    const week = isoWeekKey(new Date(), env.TZ);
    const report = await scheduleRecurring(ctx, { jobType: 'weekly_report', periodKey: week });
    logger.info({ ...report, period: week }, 'scheduled weekly report');

    // Housekeeping runs every hour: confirm due publications, release abandoned work, dead-letter
    // anything past its budget. The hour is the period key, so restarts do not pile jobs up.
    const hour = new Date().toISOString().slice(0, 13);
    const sweep = await scheduleRecurring(ctx, { jobType: 'system_sweep', periodKey: hour });
    logger.info({ ...sweep, period: hour }, 'scheduled housekeeping sweep');
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
