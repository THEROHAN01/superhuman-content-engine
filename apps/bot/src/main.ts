/**
 * Telegram bot helper.
 *
 * Two jobs, both operator-facing:
 *   `set-webhook`   registers the API's webhook URL with the secret token
 *   `delete-webhook` removes it (needed before polling)
 *   `poll`          development long-poller that forwards updates to the local API, so the
 *                   approval loop is testable without exposing a public URL
 *
 * Business logic lives in the API; this process only moves updates.
 */
import { createLogger, getEnv, EnvError } from '@sce/utils';

const usage = `usage: sce-bot <set-webhook|delete-webhook|poll>

  set-webhook     register WEBHOOK_URL with Telegram (requires TELEGRAM_WEBHOOK_SECRET)
  delete-webhook  remove the registered webhook
  poll            long-poll updates and forward them to API_BASE_URL/webhooks/telegram
`;

const telegramCall = async (
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; result?: unknown; description?: string }> => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  return (await response.json()) as { ok: boolean; result?: unknown; description?: string };
};

const main = async (): Promise<void> => {
  const command = process.argv[2];
  if (!command || !['set-webhook', 'delete-webhook', 'poll'].includes(command)) {
    console.error(usage);
    process.exit(1);
  }

  let env;
  try {
    env = getEnv();
  } catch (error) {
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(78);
  }

  const logger = createLogger({ name: 'bot', level: env.LOG_LEVEL });
  if (env.TELEGRAM_PROVIDER !== 'telegram' || !env.TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_PROVIDER must be "telegram" and TELEGRAM_BOT_TOKEN must be set');
    process.exit(78);
  }

  const token = env.TELEGRAM_BOT_TOKEN;
  const apiBase = process.env['API_BASE_URL'] ?? `http://127.0.0.1:${env.API_PORT}`;

  if (command === 'set-webhook') {
    const webhookUrl = process.env['WEBHOOK_URL'];
    if (!webhookUrl) {
      console.error('WEBHOOK_URL is required (the public https URL of /webhooks/telegram)');
      process.exit(78);
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      console.error('TELEGRAM_WEBHOOK_SECRET is required so inbound updates can be authenticated');
      process.exit(78);
    }

    const result = await telegramCall(
      token,
      'setWebhook',
      {
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['callback_query', 'message'],
        drop_pending_updates: false,
      },
      env.TELEGRAM_TIMEOUT_MS,
    );
    console.log(result.ok ? `webhook registered: ${webhookUrl}` : `failed: ${result.description}`);
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'delete-webhook') {
    const result = await telegramCall(token, 'deleteWebhook', {}, env.TELEGRAM_TIMEOUT_MS);
    console.log(result.ok ? 'webhook deleted' : `failed: ${result.description}`);
    process.exit(result.ok ? 0 : 1);
  }

  // ---------------------------------------------------------------- poll
  logger.info({ apiBase }, 'polling telegram for updates (development mode)');
  let offset = 0;
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  while (!stopping) {
    let updates: Array<{ update_id: number }>;
    try {
      const response = await telegramCall(
        token,
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['callback_query', 'message'] },
        30_000,
      );
      updates = (response.result as Array<{ update_id: number }>) ?? [];
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : 'unknown' },
        'getUpdates failed; retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      try {
        // Forwarded with the same secret header the webhook path expects, so polling and webhook
        // delivery go through identical authentication and idempotency handling.
        const forwarded = await fetch(`${apiBase}/webhooks/telegram`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(env.TELEGRAM_WEBHOOK_SECRET
              ? { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET }
              : {}),
          },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify(update),
        });
        logger.info({ update_id: update.update_id, status: forwarded.status }, 'update forwarded');
      } catch (error) {
        logger.error(
          { update_id: update.update_id, err: error instanceof Error ? error.message : 'unknown' },
          'failed to forward update; it will be redelivered by Telegram offset semantics only if not acknowledged',
        );
      }
    }
  }

  logger.info('poller stopped');
};

void main();
