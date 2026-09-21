import { permanent, type Result } from '@sce/utils';
import type {
  ApprovalCard,
  CallbackAck,
  EditMessage,
  SentMessage,
  TelegramAdapter,
} from './types.js';
import { TELEGRAM_LIMITS } from './types.js';

/**
 * In-memory Telegram. Records everything it was asked to send so tests and local development can
 * assert on the approval card without a bot token, and enforces the same limits as the real
 * adapter so a card that would fail in production fails here too.
 */
export interface MockTelegramAdapter extends TelegramAdapter {
  readonly sent: Array<ApprovalCard & { messageId: string }>;
  readonly acks: CallbackAck[];
  readonly edits: EditMessage[];
  reset(): void;
}

export const createMockTelegramAdapter = (): MockTelegramAdapter => {
  const sent: Array<ApprovalCard & { messageId: string }> = [];
  const acks: CallbackAck[] = [];
  const edits: EditMessage[] = [];
  let counter = 0;

  return {
    name: 'mock',
    sent,
    acks,
    edits,
    reset() {
      sent.length = 0;
      acks.length = 0;
      edits.length = 0;
      counter = 0;
    },

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
                data: button.data,
              }),
            };
          }
        }
      }

      counter += 1;
      const messageId = `mock-msg-${counter}`;
      sent.push({ ...card, messageId });
      return { ok: true, value: { messageId, chatId: card.chatId } };
    },

    async acknowledge(ack: CallbackAck): Promise<Result<void>> {
      acks.push(ack);
      return { ok: true, value: undefined };
    },

    async edit(message: EditMessage): Promise<Result<void>> {
      edits.push(message);
      return { ok: true, value: undefined };
    },
  };
};
