import type { FastifyInstance } from 'fastify';
import { newCorrelationId } from '@sce/utils';

/**
 * Attaches a correlation id to every request: taken from the caller when supplied (so n8n can
 * thread one id through a whole pipeline), generated otherwise, and always echoed back.
 */
declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export const correlationPlugin = (app: FastifyInstance): void => {
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers['x-correlation-id'];
    const supplied = Array.isArray(header) ? header[0] : header;
    const valid = typeof supplied === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(supplied);
    request.correlationId = valid ? supplied! : newCorrelationId();
    reply.header('x-correlation-id', request.correlationId);
  });
};
