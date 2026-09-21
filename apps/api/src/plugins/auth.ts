import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '@sce/utils';
import { safeEqual } from '@sce/utils';

/**
 * Bearer authentication for capture endpoints.
 *
 * A token is required whenever one is configured; when the API is bound to loopback and no token
 * is set, local development stays frictionless. Env validation already refuses to boot a
 * non-loopback bind without a token, so "no token" can only mean "local only".
 */
export const requireCaptureAuth =
  (env: Env) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!env.CAPTURE_API_TOKEN) return;

    const header = request.headers.authorization;
    const provided =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : '';

    if (!provided || !safeEqual(provided, env.CAPTURE_API_TOKEN)) {
      await reply.code(401).send({
        error: { code: 'E_UNAUTHORIZED', message: 'a valid bearer token is required' },
        correlation_id: request.correlationId,
      });
    }
  };
