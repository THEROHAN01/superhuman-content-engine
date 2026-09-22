import type { FastifyInstance } from 'fastify';

/**
 * Keeps the raw request body alongside the parsed one.
 *
 * Webhook signatures are computed over the exact bytes sent. Re-serializing parsed JSON changes
 * whitespace and key order, so verifying against it would reject valid deliveries - and, worse,
 * could accept a payload whose re-serialization differs from what was actually signed.
 */
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export const rawBodyPlugin = (app: FastifyInstance, options: { bodyLimit: number }): void => {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: options.bodyLimit },
    (request, body, done) => {
      const raw = body as Buffer;
      request.rawBody = raw;

      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw.toString('utf8')));
      } catch (error) {
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );
};
