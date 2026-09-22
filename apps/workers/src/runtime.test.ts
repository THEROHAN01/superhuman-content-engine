import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, hasTestDatabase, jobs as jobsRepo, type TestDb } from '@sce/db';
import { createLogger, fixedClock, newId, parseEnv } from '@sce/utils';
import type { ServiceContext } from '@sce/core';
import { runOnce, runWorker, scheduleRecurring, type JobHandler } from './runtime.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('job runtime', () => {
  let db: TestDb;
  let ctx: ServiceContext;
  const log = createLogger({ name: 'test', level: 'silent' });

  beforeAll(async () => {
    db = await createTestDb('worker_runtime');
    ctx = {
      db: db.db,
      env: parseEnv({
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
      logger: log,
      clock: fixedClock('2026-09-23T12:00:00.000Z'),
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.truncate();
  });

  const enqueue = (
    jobType: string,
    payload: Record<string, unknown> = {},
    dedupeKey = 'probe-default',
  ) =>
    jobsRepo.enqueueJob(db.db, {
      id: newId('job'),
      job_type: jobType,
      dedupe_key: dedupeKey,
      payload,
      correlation_id: 'cor_test',
    });

  it('runs a claimed job and marks it succeeded', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const handler: JobHandler = async (_ctx, payload) => {
      seen.push(payload);
      return { done: true };
    };

    await enqueue('probe', { value: 42 });
    const result = await runOnce(ctx, { handlers: { probe: handler } }, log);

    expect(result).toMatchObject({ claimed: true, jobType: 'probe', outcome: 'succeeded' });
    expect(seen).toEqual([{ value: 42 }]);
    const stored = await jobsRepo.listJobs(db.db, {});
    expect(stored[0]!.status).toBe('succeeded');
  });

  it('reports nothing to do when the queue is empty', async () => {
    expect(await runOnce(ctx, { handlers: {} }, log)).toEqual({ claimed: false });
  });

  it('enqueuing the same work twice produces one job', async () => {
    const first = await enqueue('probe', {}, 'same-key');
    const second = await enqueue('probe', {}, 'same-key');

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    const { rows } = await db.db.query<{ count: number }>('SELECT count(*)::int FROM jobs');
    expect(rows[0]!.count).toBe(1);
  });

  it('allows the same work again once the first run has finished', async () => {
    await enqueue('probe', {}, 'same-key');
    await runOnce(ctx, { handlers: { probe: async () => 'ok' } }, log);

    const again = await enqueue('probe', {}, 'same-key');
    expect(again.enqueued).toBe(true);
  });

  it('retries a failing job with backoff, then marks it dead', async () => {
    const failing: JobHandler = async () => {
      throw new Error('provider exploded');
    };
    await jobsRepo.enqueueJob(db.db, {
      id: newId('job'),
      job_type: 'probe',
      dedupe_key: 'fails',
      max_attempts: 2,
      correlation_id: 'cor_test',
    });

    const first = await runOnce(ctx, { handlers: { probe: failing } }, log);
    expect(first.outcome).toBe('retry');

    // Make the retry due immediately, then fail it again to exhaust the budget.
    await db.db.query(`UPDATE jobs SET run_after = now() - interval '1 minute'`);
    const second = await runOnce(ctx, { handlers: { probe: failing } }, log);
    expect(second.outcome).toBe('dead');

    const stored = await jobsRepo.listJobs(db.db, {});
    expect(stored[0]!.status).toBe('dead');
    expect(stored[0]!.last_error).toContain('provider exploded');
  });

  it('kills a job whose type has no handler rather than retrying forever', async () => {
    await enqueue('unknown_type', {}, 'unknown-type-key');
    const result = await runOnce(ctx, { handlers: {} }, log);
    expect(result.outcome).toBe('dead');

    const stored = await jobsRepo.listJobs(db.db, {});
    expect(stored[0]!.last_error).toContain('no handler');
  });

  it('two workers never run the same job', async () => {
    for (let i = 0; i < 4; i++) await enqueue('probe', { i }, `key-${i}`);

    const ran: number[] = [];
    const handler: JobHandler = async (_ctx, payload) => {
      ran.push(payload['i'] as number);
      return null;
    };

    // Four concurrent claims across "two workers": each job runs exactly once.
    await Promise.all([
      runOnce(ctx, { handlers: { probe: handler }, workerId: 'w1' }, log),
      runOnce(ctx, { handlers: { probe: handler }, workerId: 'w2' }, log),
      runOnce(ctx, { handlers: { probe: handler }, workerId: 'w1' }, log),
      runOnce(ctx, { handlers: { probe: handler }, workerId: 'w2' }, log),
    ]);

    expect(ran.sort()).toEqual([0, 1, 2, 3]);
    const stored = await jobsRepo.listJobs(db.db, {});
    expect(stored.every((job) => job.status === 'succeeded')).toBe(true);
  });

  it('releases a job abandoned by a dead worker', async () => {
    await enqueue('probe');
    await db.db.query(
      `UPDATE jobs SET status = 'running', locked_at = now() - interval '1 hour', locked_by = 'dead-worker'`,
    );

    expect(await jobsRepo.releaseStaleJobs(db.db, 10 * 60_000)).toBe(1);
    const result = await runOnce(ctx, { handlers: { probe: async () => 'recovered' } }, log);
    expect(result.outcome).toBe('succeeded');
  });

  it('drains the queue then stops when idle', async () => {
    for (let i = 0; i < 3; i++) await enqueue('probe', { i }, `drain-${i}`);
    let handled = 0;

    await runWorker(
      ctx,
      {
        handlers: {
          probe: async () => {
            handled += 1;
            return null;
          },
        },
        maxIdlePolls: 1,
        sleep: async () => {},
      },
      log,
      { stopped: false },
    );

    expect(handled).toBe(3);
  });

  it('scheduleRecurring is safe to call repeatedly for the same period', async () => {
    const first = await scheduleRecurring(ctx, {
      jobType: 'collect_analytics',
      periodKey: '2026-09-23',
    });
    const second = await scheduleRecurring(ctx, {
      jobType: 'collect_analytics',
      periodKey: '2026-09-23',
    });
    const tomorrow = await scheduleRecurring(ctx, {
      jobType: 'collect_analytics',
      periodKey: '2026-09-24',
    });

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(tomorrow.enqueued).toBe(true);
  });
});
