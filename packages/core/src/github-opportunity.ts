import { learningEvents, operations } from '@sce/db';
import {
  assessSignificance,
  parseGithubEvent,
  toLearningText,
  type EngineeringEvent,
} from '@sce/adapters';
import { contentHash, newId, permanent, type Result } from '@sce/utils';
import type { LearningEvent } from '@sce/schemas';
import type { ServiceContext } from './context.js';

/**
 * GitHub engineering events as learning capture.
 *
 * A merged pull request or a published release enters the pipeline exactly like a hand-written
 * note: as a `learning_events` row with `source: 'github'`. That reuses normalization,
 * classification, atom building, ideation, generation and the quality gate rather than growing a
 * parallel path - and it means an engineering opportunity is subject to the same human approval.
 *
 * Deduplication has two layers: the webhook delivery id (GitHub redelivers) and the event's own
 * id in `(source, external_id)` (GitHub can send the same PR through several deliveries).
 */
export interface IngestOptions {
  /** Skip the significance filter - the manual "this one matters" override. */
  force?: boolean;
  correlationId?: string;
}

export interface IngestResult {
  status: 'captured' | 'duplicate' | 'filtered';
  learning_event: LearningEvent | null;
  event: EngineeringEvent | null;
  reason: string;
  score: number;
}

export const ingestGithubEvent = async (
  ctx: ServiceContext,
  input: { eventType: string; payload: unknown },
  options: IngestOptions = {},
): Promise<Result<IngestResult>> => {
  const parsed = parseGithubEvent(input.eventType, input.payload);
  if (!parsed.matched) {
    return {
      ok: true,
      value: {
        status: 'filtered',
        learning_event: null,
        event: null,
        reason: parsed.reason,
        score: 0,
      },
    };
  }

  const event = parsed.event;
  const correlationId =
    options.correlationId ?? `cor_gh_${event.externalId.replace(/[^a-z0-9]/gi, '_')}`;
  const log = ctx.logger.child({
    workflow: 'github_opportunity_v1',
    correlation_id: correlationId,
  });

  const significance = assessSignificance(event);
  if (!significance.significant && options.force !== true) {
    // Filtering is recorded, not silent: an operator can see why something was skipped and force it.
    log.info(
      { external_id: event.externalId, reason: significance.reason },
      'github event filtered as not content-worthy',
    );
    return {
      ok: true,
      value: {
        status: 'filtered',
        learning_event: null,
        event,
        reason: significance.reason,
        score: significance.score,
      },
    };
  }

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'github_opportunity_v1',
    correlationId,
    subjectId: event.externalId,
    input: { kind: event.kind, repository: event.repository, forced: options.force === true },
  });

  const text = toLearningText(event);
  const { event: learningEvent, inserted } = await learningEvents.insertLearningEvent(ctx.db, {
    id: newId('learningEvent'),
    source: 'github',
    external_id: event.externalId,
    raw_text: text,
    title: event.title.slice(0, 200),
    content_hash: contentHash(text),
    tags: ['github', event.kind, ...event.labels.slice(0, 3)],
    context: {
      repository: event.repository,
      url: event.url,
      ref: event.ref,
      sha: event.sha,
      author: event.author,
      occurred_at: event.occurredAt,
      stats: event.stats,
      significance: {
        score: significance.score,
        reason: significance.reason,
        forced: options.force === true,
      },
    },
    captured_at: event.occurredAt ?? ctx.clock().toISOString(),
    correlation_id: correlationId,
  });

  log.info(
    { learning_event_id: learningEvent.id, external_id: event.externalId, duplicate: !inserted },
    inserted ? 'github event captured as a learning event' : 'github event already captured',
  );
  await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
    learning_event_id: learningEvent.id,
    duplicate: !inserted,
  });

  return {
    ok: true,
    value: {
      status: inserted ? 'captured' : 'duplicate',
      learning_event: learningEvent,
      event,
      reason: significance.reason,
      score: significance.score,
    },
  };
};

/** Manual override: force an already-seen or filtered event into the pipeline. */
export const forceGithubOpportunity = async (
  ctx: ServiceContext,
  input: { eventType: string; payload: unknown },
): Promise<Result<IngestResult>> => {
  if (!input.payload || typeof input.payload !== 'object') {
    return {
      ok: false,
      error: permanent('E_INVALID_PAYLOAD', 'a GitHub event payload is required'),
    };
  }
  return ingestGithubEvent(ctx, input, { force: true });
};
