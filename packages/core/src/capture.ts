import type { CaptureLearningEventInput, CaptureLearningEventResult } from '@sce/schemas';
import { captureLearningEventInput } from '@sce/schemas';
import { learningEvents, operations } from '@sce/db';
import { contentHash, newCorrelationId, newId, permanent, type Result } from '@sce/utils';
import type { ServiceContext } from './context.js';

/**
 * Learning capture.
 *
 * The one rule that matters here: the raw note is stored exactly as received and the same note
 * captured twice yields one event. Deduplication is enforced by a unique index, so two concurrent
 * captures converge on the same row instead of racing.
 */
export const captureLearningEvent = async (
  ctx: ServiceContext,
  rawInput: unknown,
): Promise<Result<CaptureLearningEventResult>> => {
  const parsed = captureLearningEventInput.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: permanent('E_INVALID_CAPTURE', 'learning event payload is invalid', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    };
  }

  const input: CaptureLearningEventInput = parsed.data;
  const correlationId = input.correlation_id ?? newCorrelationId();
  const log = ctx.logger.child({ correlation_id: correlationId, workflow: 'learning_capture_v1' });

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'learning_capture_v1',
    correlationId,
    input: { source: input.source, chars: input.text.length },
  });

  try {
    const hash = contentHash(input.text);
    const { event, inserted } = await learningEvents.insertLearningEvent(ctx.db, {
      id: newId('learningEvent'),
      source: input.source,
      external_id: input.external_id ?? null,
      raw_text: input.text,
      title: input.title ?? null,
      content_hash: hash,
      tags: input.tags,
      context: input.context,
      captured_at: input.captured_at ?? ctx.clock().toISOString(),
      correlation_id: correlationId,
    });

    log.info(
      { learning_event_id: event.id, duplicate: !inserted, source: input.source },
      inserted ? 'learning event captured' : 'duplicate capture returned the original event',
    );

    await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
      learning_event_id: event.id,
      duplicate: !inserted,
    });

    return {
      ok: true,
      value: { learning_event: event, duplicate: !inserted, correlation_id: correlationId },
    };
  } catch (error) {
    await operations.recordError(ctx.db, {
      workflow: 'learning_capture_v1',
      step: 'insert',
      kind: 'transient',
      code: 'E_CAPTURE_FAILED',
      message: error instanceof Error ? error.message : 'unknown capture failure',
      correlationId,
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', { error: 'capture failed' });
    throw error;
  }
};

export const getLearningEvent = async (ctx: ServiceContext, id: string) =>
  learningEvents.findLearningEvent(ctx.db, id);

export const listLearningEvents = async (
  ctx: ServiceContext,
  options: Parameters<typeof learningEvents.listLearningEvents>[1],
) => learningEvents.listLearningEvents(ctx.db, options);
