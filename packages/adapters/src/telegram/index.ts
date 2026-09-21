import type { Env } from '@sce/utils';
import { transient } from '@sce/utils';
import type { TelegramAdapter } from './types.js';
import { createMockTelegramAdapter } from './mock.js';
import { createTelegramAdapter } from './telegram.js';

export * from './types.js';
export { createMockTelegramAdapter, type MockTelegramAdapter } from './mock.js';
export { createTelegramAdapter } from './telegram.js';

export const createFailingTelegramAdapter = (): TelegramAdapter => ({
  name: 'failing',
  async send() {
    return {
      ok: false,
      error: transient('E_TELEGRAM_UNREACHABLE', 'telegram is configured to fail'),
    };
  },
  async acknowledge() {
    return {
      ok: false,
      error: transient('E_TELEGRAM_UNREACHABLE', 'telegram is configured to fail'),
    };
  },
  async edit() {
    return {
      ok: false,
      error: transient('E_TELEGRAM_UNREACHABLE', 'telegram is configured to fail'),
    };
  },
});

export const createTelegramAdapterFor = (
  env: Env,
  overrides: { fetchImpl?: typeof fetch } = {},
): TelegramAdapter => {
  switch (env.TELEGRAM_PROVIDER) {
    case 'telegram':
      return createTelegramAdapter({
        botToken: env.TELEGRAM_BOT_TOKEN!,
        timeoutMs: env.TELEGRAM_TIMEOUT_MS,
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      });
    case 'failing':
      return createFailingTelegramAdapter();
    case 'mock':
    default:
      return createMockTelegramAdapter();
  }
};
