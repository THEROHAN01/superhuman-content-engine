import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { operations } from '@sce/db';
import { AppError } from '@sce/utils';
import type { ServiceContext } from '@sce/core';
import { requireCaptureAuth } from '../plugins/auth.js';

/**
 * Endpoints used by n8n and operators rather than by humans.
 *
 * The shared n8n error workflow posts here, so a failure anywhere in the orchestration layer ends
 * up in the same `error_events` table as a failure inside the API - one place to look when
 * something stalls.
 */
const errorReport = z.object({
  workflow: z.string().min(1).max(80),
  step: z.string().max(80).optional(),
  kind: z.enum(['transient', 'permanent']).default('transient'),
  code: z.string().min(2).max(80).default('E_WORKFLOW_FAILED'),
  message: z.string().min(1).max(4000),
  correlation_id: z.string().max(128).optional(),
  subject_id: z.string().max(80).optional(),
  details: z.record(z.unknown()).optional(),
});

export const internalRoutes = (app: FastifyInstance, ctx: ServiceContext): void => {
  const auth = requireCaptureAuth(ctx.env);

  app.post('/internal/errors', { preHandler: auth }, async (request, reply) => {
    const parsed = errorReport.safeParse(request.body);
    if (!parsed.success) {
      throw AppError.permanent('E_INVALID_ERROR_REPORT', 'error report payload is invalid', 422, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const report = parsed.data;
    const correlationId = report.correlation_id ?? request.correlationId;
    const id = await operations.recordError(ctx.db, {
      workflow: report.workflow,
      step: report.step ?? null,
      kind: report.kind,
      code: report.code,
      message: report.message,
      correlationId,
      subjectId: report.subject_id ?? null,
      details: report.details ?? null,
    });

    request.log.error(
      {
        workflow: report.workflow,
        step: report.step,
        code: report.code,
        correlation_id: correlationId,
      },
      'workflow failure reported',
    );

    return reply.code(201).send({ id, correlation_id: correlationId });
  });

  /** Recent failures and runs - what the health workflow and an operator actually need. */
  app.get<{ Querystring: { correlation_id?: string; limit?: string } }>(
    '/internal/errors',
    { preHandler: auth },
    async (request) => {
      const limit = request.query.limit ? Number(request.query.limit) : 20;
      const events = await operations.listErrorEvents(ctx.db, {
        correlationId: request.query.correlation_id,
        limit: Number.isFinite(limit) ? limit : 20,
      });
      return { events, count: events.length };
    },
  );

  app.get<{ Querystring: { correlation_id?: string; workflow?: string; limit?: string } }>(
    '/internal/runs',
    { preHandler: auth },
    async (request) => {
      const limit = request.query.limit ? Number(request.query.limit) : 20;
      const runs = await operations.listWorkflowRuns(ctx.db, {
        correlationId: request.query.correlation_id,
        workflow: request.query.workflow,
        limit: Number.isFinite(limit) ? limit : 20,
      });
      return { runs, count: runs.length };
    },
  );
};
