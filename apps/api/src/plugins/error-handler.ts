import type { FastifyInstance } from 'fastify';
import { AppError, describeError } from '@sce/utils';

/**
 * One error shape for the whole API: `{error: {code, message, details?}, correlation_id}`.
 * Internal errors never leak their message to the caller, but are always logged with the
 * correlation id so the request can be traced.
 */
export const errorHandlerPlugin = (app: FastifyInstance): void => {
  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId;

    if (error instanceof AppError) {
      request.log.warn(
        { err: describeError(error), code: error.code, correlation_id: correlationId },
        'request failed',
      );
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
        correlation_id: correlationId,
      });
    }

    // Fastify's own validation and payload errors carry a statusCode and code.
    const fastifyError = error as {
      statusCode?: number;
      code?: string;
      message?: string;
      stack?: string;
    };
    const statusCode = fastifyError.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          code: fastifyError.code ?? 'E_BAD_REQUEST',
          message: fastifyError.message ?? 'bad request',
        },
        correlation_id: correlationId,
      });
    }

    request.log.error(
      { err: describeError(error), stack: fastifyError.stack, correlation_id: correlationId },
      'unhandled error',
    );
    return reply.code(500).send({
      error: { code: 'E_INTERNAL', message: 'internal error' },
      correlation_id: correlationId,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'E_NOT_FOUND', message: `no route for ${request.method} ${request.url}` },
      correlation_id: request.correlationId,
    }),
  );
};
