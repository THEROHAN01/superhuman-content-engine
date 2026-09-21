import { permanent, transient, type Result } from '@sce/utils';
import type {
  ApprovalCard,
  CallbackAck,
  EditMessage,
  SentMessage,
  TelegramAdapter,
} from './types.js';
import { TELEGRAM_LIMITS } from './types.js';

/**
 * Telegram Bot API adapter.
 *
 * Endpoints used (all documented):
 *   POST https://api.telegram.org/bot<token>/sendMessage
 *   POST https://api.telegram.org/bot<token>/answerCallbackQuery
 *   POST https://api.telegram.org/bot<token>/editMessageText
 *
 * The token is a path segment, so it must never appear in a log line or an error detail - error
 * paths here deliberately carry only the method name and status.
 */
export interface TelegramOptions {
  botToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const call = async <T>(
  options: TelegramOptions,
  method: string,
  body: Record<string, unknown>,
): Promise<Result<T>> => {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${options.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs),
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      error: transient('E_TELEGRAM_UNREACHABLE', `telegram ${method} failed`, { method }, error),
    };
  }

  let payload: TelegramResponse<T>;
  try {
    payload = (await response.json()) as TelegramResponse<T>;
  } catch (error) {
    return {
      ok: false,
      error: permanent(
        'E_TELEGRAM_BAD_RESPONSE',
        `telegram ${method} returned a non-JSON body`,
        {
          method,
          status: response.status,
        },
        error,
      ),
    };
  }

  if (!response.ok || !payload.ok) {
    const retryAfter = payload.parameters?.retry_after;
    const details: Record<string, unknown> = {
      method,
      status: response.status,
      // `description` is Telegram's own error text; it never contains the token.
      description: payload.description?.slice(0, 200),
    };
    if (retryAfter) details['retryAfterMs'] = retryAfter * 1000;

    const retryable = response.status === 429 || response.status >= 500;
    return {
      ok: false,
      error: retryable
        ? transient('E_TELEGRAM_HTTP', `telegram ${method} returned ${response.status}`, details)
        : permanent('E_TELEGRAM_HTTP', `telegram ${method} returned ${response.status}`, details),
    };
  }

  return { ok: true, value: payload.result as T };
};

export const createTelegramAdapter = (options: TelegramOptions): TelegramAdapter => ({
  name: 'telegram',

  async send(card: ApprovalCard): Promise<Result<SentMessage>> {
    if (card.text.length > TELEGRAM_LIMITS.messageChars) {
      return {
        ok: false,
        error: permanent('E_TELEGRAM_TOO_LONG', 'message exceeds the Telegram length limit', {
          length: card.text.length,
        }),
      };
    }
    for (const row of card.buttons) {
      for (const button of row) {
        if (Buffer.byteLength(button.data, 'utf8') > TELEGRAM_LIMITS.callbackDataBytes) {
          return {
            ok: false,
            error: permanent('E_TELEGRAM_CALLBACK_TOO_LONG', 'callback data exceeds 64 bytes', {
              bytes: Buffer.byteLength(button.data, 'utf8'),
            }),
          };
        }
      }
    }

    const result = await call<{ message_id: number; chat: { id: number } }>(
      options,
      'sendMessage',
      {
        chat_id: card.chatId,
        text: card.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: card.buttons.map((row) =>
            row.map((button) => ({ text: button.label, callback_data: button.data })),
          ),
        },
      },
    );

    if (!result.ok) return result;
    return {
      ok: true,
      value: { messageId: String(result.value.message_id), chatId: String(result.value.chat.id) },
    };
  },

  async acknowledge(ack: CallbackAck): Promise<Result<void>> {
    const result = await call<boolean>(options, 'answerCallbackQuery', {
      callback_query_id: ack.callbackQueryId,
      ...(ack.text ? { text: ack.text.slice(0, 200) } : {}),
    });
    return result.ok ? { ok: true, value: undefined } : result;
  },

  async edit(message: EditMessage): Promise<Result<void>> {
    const result = await call<unknown>(options, 'editMessageText', {
      chat_id: message.chatId,
      message_id: Number(message.messageId),
      text: message.text.slice(0, TELEGRAM_LIMITS.messageChars),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(message.removeButtons ? { reply_markup: { inline_keyboard: [] } } : {}),
    });
    return result.ok ? { ok: true, value: undefined } : result;
  },
});
