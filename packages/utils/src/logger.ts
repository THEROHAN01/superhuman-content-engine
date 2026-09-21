import { pino, type Logger } from 'pino';

/**
 * Structured logging with redaction. Credentials must never reach a log line, so redaction is
 * configured centrally rather than trusted to call sites.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'req.headers["x-hub-signature-256"]',
  'headers.authorization',
  'password',
  'token',
  'apiKey',
  'api_key',
  'secret',
  'bot_token',
  'TELEGRAM_BOT_TOKEN',
  'POSTIZ_API_KEY',
  'DATABASE_URL',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.secret',
];

export interface LoggerOptions {
  level?: string;
  name?: string;
  /** Pretty output is for humans only; production always emits JSON. */
  pretty?: boolean;
}

export const createLogger = (options: LoggerOptions = {}): Logger =>
  pino({
    name: options.name ?? 'sce',
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { service: options.name ?? 'sce' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

export type { Logger };

/** Child logger bound to a correlation id, so one capture is traceable across every stage. */
export const withCorrelation = (logger: Logger, correlationId: string): Logger =>
  logger.child({ correlation_id: correlationId });
