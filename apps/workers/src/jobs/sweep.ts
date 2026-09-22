import {
  markPublished,
  dueScheduledPublications,
  sweepStuckWork,
  type ServiceContext,
} from '@sce/core';

/**
 * Housekeeping job.
 *
 * Confirms publications whose scheduled slot has passed, releases work abandoned by a crashed
 * worker, and dead-letters anything that has exhausted its retry budget. Every step is idempotent,
 * so running it more often than necessary is harmless.
 */
export const sweepJob = async (ctx: ServiceContext): Promise<unknown> => {
  const due = await dueScheduledPublications(ctx);
  let confirmed = 0;
  for (const publication of due) {
    const result = await markPublished(ctx, publication.id);
    if (result.ok) confirmed += 1;
  }

  const sweep = await sweepStuckWork(ctx);
  return { confirmed_publications: confirmed, ...sweep };
};
