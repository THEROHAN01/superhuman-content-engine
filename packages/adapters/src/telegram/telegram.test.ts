import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '@sce/utils';
import {
  createFailingTelegramAdapter,
  createMockTelegramAdapter,
  createTelegramAdapter,
  createTelegramAdapterFor,
  TELEGRAM_LIMITS,
} from './index.js';

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

describe('telegram adapter', () => {
  const base = { botToken: '123456:AA-secret-token-value', timeoutMs: 1000 };
  const card = {
    chatId: '42',
    text: 'Approve this?',
    buttons: [[{ label: 'Approve', data: 'sce:ap:it_abc:1' }]],
  };

  it('posts to sendMessage with an inline keyboard and returns the message id', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/sendMessage');
      const body = JSON.parse(String(init?.body)) as {
        chat_id: string;
        reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
      };
      expect(body.chat_id).toBe('42');
      expect(body.reply_markup.inline_keyboard[0]![0]!.callback_data).toBe('sce:ap:it_abc:1');
      return ok({ message_id: 99, chat: { id: 42 } });
    });

    const result = await createTelegramAdapter({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).send(card);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe('99');
  });

  it('never puts the bot token anywhere except the request URL', async () => {
    const seen: string[] = [];
    const adapter = createTelegramAdapter({
      ...base,
      fetchImpl: (async (url: unknown, init: RequestInit) => {
        seen.push(String(init.body));
        return new Response(
          JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }),
          {
            status: 400,
          },
        );
      }) as unknown as typeof fetch,
    });

    const result = await adapter.send(card);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The token must not leak into the request body or into the failure we log and store.
    expect(seen.join(' ')).not.toContain(base.botToken);
    expect(JSON.stringify(result.error)).not.toContain(base.botToken);
    expect(result.error.details?.['description']).toContain('chat not found');
  });

  it('classifies 429 as transient and surfaces retry_after', async () => {
    const result = await createTelegramAdapter({
      ...base,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            description: 'Too Many Requests',
            parameters: { retry_after: 12 },
          }),
          {
            status: 429,
          },
        )) as unknown as typeof fetch,
    }).send(card);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('transient');
    expect(result.error.details?.['retryAfterMs']).toBe(12_000);
  });

  it('classifies 400 as permanent and 5xx as transient', async () => {
    const withStatus = (status: number) =>
      createTelegramAdapter({
        ...base,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ok: false }), { status })) as unknown as typeof fetch,
      }).send(card);

    expect((await withStatus(400)).ok).toBe(false);
    const permanent = await withStatus(400);
    if (!permanent.ok) expect(permanent.error.kind).toBe('permanent');

    const transient = await withStatus(502);
    if (!transient.ok) expect(transient.error.kind).toBe('transient');
  });

  it('treats a network failure as transient', async () => {
    const result = await createTelegramAdapter({
      ...base,
      fetchImpl: (async () => {
        throw new DOMException('aborted', 'TimeoutError');
      }) as unknown as typeof fetch,
    }).send(card);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_TELEGRAM_UNREACHABLE');
  });

  it('refuses callback data that exceeds the Telegram limit before sending', async () => {
    const fetchImpl = vi.fn(async () => ok({ message_id: 1, chat: { id: 1 } }));
    const result = await createTelegramAdapter({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).send({
      ...card,
      buttons: [[{ label: 'x', data: 'y'.repeat(TELEGRAM_LIMITS.callbackDataBytes + 1) }]],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_TELEGRAM_CALLBACK_TOO_LONG');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers a callback query and edits a message', async () => {
    const calls: string[] = [];
    const adapter = createTelegramAdapter({
      ...base,
      fetchImpl: (async (url: unknown) => {
        calls.push(String(url).split('/').pop()!);
        return ok(true);
      }) as unknown as typeof fetch,
    });

    await adapter.acknowledge({ callbackQueryId: 'cbq-1', text: 'Recorded' });
    await adapter.edit({
      chatId: '42',
      messageId: '99',
      text: 'Decision: approve',
      removeButtons: true,
    });
    expect(calls).toEqual(['answerCallbackQuery', 'editMessageText']);
  });
});

describe('mock telegram adapter', () => {
  it('records what it was asked to send and enforces the same limits', async () => {
    const adapter = createMockTelegramAdapter();
    await adapter.send({
      chatId: '1',
      text: 'hello',
      buttons: [[{ label: 'ok', data: 'sce:ap:it_a:1' }]],
    });
    expect(adapter.sent).toHaveLength(1);

    const tooLong = await adapter.send({
      chatId: '1',
      text: 'x'.repeat(TELEGRAM_LIMITS.messageChars + 1),
      buttons: [],
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.code).toBe('E_TELEGRAM_TOO_LONG');
  });
});

describe('provider selection', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/sce' };

  it('defaults to mock', () => {
    expect(createTelegramAdapterFor(parseEnv(base as NodeJS.ProcessEnv)).name).toBe('mock');
  });

  it('uses the real adapter when fully configured', () => {
    const env = parseEnv({
      ...base,
      TELEGRAM_PROVIDER: 'telegram',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_CHAT_ID: '42',
      TELEGRAM_WEBHOOK_SECRET: 'a-sufficiently-long-secret',
    } as NodeJS.ProcessEnv);
    expect(createTelegramAdapterFor(env).name).toBe('telegram');
  });

  it('fails every operation in the failing provider', async () => {
    const adapter = createFailingTelegramAdapter();
    expect((await adapter.send({ chatId: '1', text: 'x', buttons: [] })).ok).toBe(false);
    expect((await adapter.acknowledge({ callbackQueryId: 'c' })).ok).toBe(false);
    expect((await adapter.edit({ chatId: '1', messageId: '1', text: 'x' })).ok).toBe(false);
  });
});
