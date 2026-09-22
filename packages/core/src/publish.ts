import { contentItems, isUniqueViolation, operations, publications } from '@sce/db';
import type { PublishingAdapter } from '@sce/adapters';
import { idempotencyKey, newId, permanent, withRetry, type Result } from '@sce/utils';
import type { Publication } from '@sce/schemas';
import type { ServiceContext } from './context.js';

/**
 * Publishing.
 *
 * Three guarantees, in order of importance:
 *   1. Only `approved` content is ever sent anywhere.
 *   2. Live sending requires `PUBLISH_MODE=live` *and* a non-simulated provider. Anything else is
 *      a dry run, recorded as such, and never counted as published content.
 *   3. The same item and slot can only be scheduled once: the publication row is claimed behind a
 *      unique idempotency key *before* the provider is called, so a crash between the two leaves a
 *      claimed row to reconcile rather than an untracked post.
 */

export const publicationIdempotencyKey = (
  itemId: string,
  platform: string,
  scheduledAt: string,
): string => idempotencyKey(itemId, platform, new Date(scheduledAt).toISOString());

export interface ScheduleOptions {
  publisher: PublishingAdapter;
  scheduledAt: string;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ScheduleResult {
  publication: Publication;
  /** False when this exact publication already existed; no provider call was made. */
  created: boolean;
  dry_run: boolean;
}

export const schedulePublication = async (
  ctx: ServiceContext,
  itemId: string,
  options: ScheduleOptions,
): Promise<Result<ScheduleResult>> => {
  const item = await contentItems.findContentItem(ctx.db, itemId);
  if (!item)
    return { ok: false, error: permanent('E_ITEM_NOT_FOUND', `no content item ${itemId}`) };

  // Guard 1: approval is not advisory.
  if (item.status !== 'approved' && item.status !== 'scheduled') {
    return {
      ok: false,
      error: permanent(
        'E_NOT_APPROVED',
        `content item ${itemId} is ${item.status}; only approved content is published`,
        {
          status: item.status,
        },
      ),
    };
  }

  const scheduledAt = new Date(options.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) {
    return {
      ok: false,
      error: permanent('E_INVALID_SCHEDULE', 'scheduled_at is not a valid timestamp'),
    };
  }

  // Guard 2: a live send needs both an explicit mode and a provider that can actually reach a
  // platform. Either one missing means dry run, recorded honestly.
  const dryRun = ctx.env.PUBLISH_MODE !== 'live' || options.publisher.simulated;

  const key = publicationIdempotencyKey(item.id, item.platform, scheduledAt.toISOString());
  const { publication, claimed } = await publications.claimPublication(ctx.db, {
    id: newId('publication'),
    content_item_id: item.id,
    learning_event_id: item.learning_event_id,
    platform: item.platform,
    idempotency_key: key,
    provider: options.publisher.name,
    scheduled_at: scheduledAt.toISOString(),
    dry_run: dryRun,
    correlation_id: item.correlation_id,
  });

  // Guard 3: someone already claimed this slot.
  //
  // A claimed row that reached the provider is final here - returning it is what makes a replay
  // safe. A claimed row that never reached the provider (no external id, still inside its attempt
  // budget) is a different situation: the provider was down, and the operator or the retry sweep
  // is asking again. Retrying it reuses the same row *and* the same idempotency key, so the
  // provider still cannot create a second post - whereas refusing would strand the publication
  // forever, since nothing else ever calls the provider for it.
  const retryable =
    !claimed &&
    publication.external_id === null &&
    (publication.status === 'pending' || publication.status === 'retry_pending') &&
    publication.attempts < ctx.env.WORKER_MAX_ATTEMPTS;

  if (!claimed && !retryable) {
    ctx.logger.info(
      {
        publication_id: publication.id,
        content_item_id: item.id,
        status: publication.status,
        attempts: publication.attempts,
      },
      'publication already exists for this item and slot; no provider call made',
    );
    return { ok: true, value: { publication, created: false, dry_run: publication.dry_run } };
  }

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'content_publish_v1',
    correlationId: item.correlation_id,
    subjectId: item.id,
    input: {
      provider: options.publisher.name,
      dry_run: dryRun,
      scheduled_at: scheduledAt.toISOString(),
      retry_of: claimed ? null : publication.id,
    },
  });

  const attempt = await withRetry(
    () =>
      options.publisher.schedule({
        idempotencyKey: key,
        platform: item.platform,
        body: item.draft.body,
        units: item.draft.units.map((unit) => unit.text),
        scheduledAt: scheduledAt.toISOString(),
        correlationId: item.correlation_id,
      }),
    {
      attempts: options.attempts ?? 3,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      onRetry: ({ attempt: n, failure }) =>
        ctx.logger.warn(
          { attempt: n, code: failure.code, publication_id: publication.id },
          'publish retry',
        ),
    },
  );

  if (!attempt.ok) {
    // Transient failures stay retryable; permanent ones are dead and visible.
    const nextStatus = attempt.error.kind === 'transient' ? 'retry_pending' : 'failed';
    await publications.setPublicationStatus(ctx.db, publication.id, nextStatus, {
      last_error: `${attempt.error.code}: ${attempt.error.message}`.slice(0, 2000),
      incrementAttempts: true,
    });

    await operations.recordError(ctx.db, {
      workflow: 'content_publish_v1',
      step: 'schedule',
      kind: attempt.error.kind,
      code: attempt.error.code,
      message: attempt.error.message,
      correlationId: item.correlation_id,
      subjectId: item.id,
      details: { publication_id: publication.id, attempts: attempt.attempts ?? null },
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', { code: attempt.error.code });

    return { ok: false, error: attempt.error };
  }

  const receipt = attempt.value;

  let updated;
  try {
    updated = await publications.setPublicationStatus(ctx.db, publication.id, 'scheduled', {
      external_id: receipt.externalId,
      external_url: receipt.externalUrl,
      // Provider metadata is stored as returned by the adapter, which has already stripped secrets.
      provider_metadata: receipt.metadata,
      last_error: '',
      incrementAttempts: true,
    });
  } catch (error) {
    // `(provider, external_id)` is unique: the provider handed us an id that already belongs to a
    // different publication. That means two of our rows would claim one post, which is exactly the
    // confusion this system exists to prevent - so it is a hard failure with the reason recorded,
    // not an unhandled database error.
    if (!isUniqueViolation(error)) throw error;

    const message = `provider returned external id ${receipt.externalId}, which is already recorded against another publication`;
    await publications.setPublicationStatus(ctx.db, publication.id, 'failed', {
      last_error: message.slice(0, 2000),
      incrementAttempts: true,
    });
    await operations.recordError(ctx.db, {
      workflow: 'content_publish_v1',
      step: 'record',
      kind: 'permanent',
      code: 'E_PUBLISH_DUPLICATE_EXTERNAL_ID',
      message,
      correlationId: item.correlation_id,
      subjectId: item.id,
      details: { publication_id: publication.id, external_id: receipt.externalId },
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', {
      code: 'E_PUBLISH_DUPLICATE_EXTERNAL_ID',
    });

    return {
      ok: false,
      error: permanent('E_PUBLISH_DUPLICATE_EXTERNAL_ID', message, {
        external_id: receipt.externalId,
      }),
    };
  }

  const transition = await contentItems.setContentItemStatus(ctx.db, item.id, 'scheduled');

  ctx.logger.info(
    {
      publication_id: publication.id,
      external_id: receipt.externalId,
      dry_run: dryRun,
      provider: options.publisher.name,
    },
    dryRun ? 'publication scheduled (dry run)' : 'publication scheduled',
  );
  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
    publication_id: publication.id,
    external_id: receipt.externalId,
    dry_run: dryRun,
  });
  void transition;

  return {
    ok: true,
    value: { publication: updated?.publication ?? publication, created: claimed, dry_run: dryRun },
  };
};

export interface CancelResult {
  publication: Publication;
  cancelled: boolean;
}

export const cancelPublication = async (
  ctx: ServiceContext,
  publicationId: string,
  options: { publisher: PublishingAdapter },
): Promise<Result<CancelResult>> => {
  const publication = await publications.findPublication(ctx.db, publicationId);
  if (!publication) {
    return {
      ok: false,
      error: permanent('E_PUBLICATION_NOT_FOUND', `no publication ${publicationId}`),
    };
  }

  if (publication.status === 'published') {
    return {
      ok: false,
      error: permanent('E_ALREADY_PUBLISHED', 'a published post cannot be unscheduled here'),
    };
  }
  if (publication.status === 'cancelled') {
    return { ok: true, value: { publication, cancelled: false } };
  }

  if (publication.external_id && !publication.dry_run) {
    const result = await options.publisher.cancel(publication.external_id);
    if (!result.ok) return { ok: false, error: result.error };
  }

  const updated = await publications.setPublicationStatus(ctx.db, publication.id, 'cancelled', {
    last_error: '',
  });
  return { ok: true, value: { publication: updated?.publication ?? publication, cancelled: true } };
};

/** Marks a scheduled publication as published; used by the worker once the slot has passed. */
export const markPublished = async (
  ctx: ServiceContext,
  publicationId: string,
): Promise<Result<Publication>> => {
  const publication = await publications.findPublication(ctx.db, publicationId);
  if (!publication) {
    return {
      ok: false,
      error: permanent('E_PUBLICATION_NOT_FOUND', `no publication ${publicationId}`),
    };
  }
  if (publication.status === 'published') return { ok: true, value: publication };
  if (publication.status !== 'scheduled') {
    return {
      ok: false,
      error: permanent('E_NOT_SCHEDULED', `publication ${publicationId} is ${publication.status}`),
    };
  }

  const updated = await publications.setPublicationStatus(ctx.db, publication.id, 'published', {
    published_at: ctx.clock().toISOString(),
  });
  await contentItems.setContentItemStatus(ctx.db, publication.content_item_id, 'published');
  return { ok: true, value: updated?.publication ?? publication };
};

export const listPublicationsForItem = async (ctx: ServiceContext, itemId: string) =>
  publications.listPublicationsForItem(ctx.db, itemId);
