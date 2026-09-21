import type { AppFailure, Result } from '@sce/utils';

/**
 * The Telegram boundary.
 *
 * Only what the approval loop needs: send a card with buttons, acknowledge a button press, and
 * edit a card after a decision so the chat shows the outcome rather than stale buttons.
 */
export interface ApprovalButton {
  label: string;
  /** Telegram limits callback_data to 64 bytes - the adapter refuses anything longer. */
  data: string;
}

export interface ApprovalCard {
  chatId: string;
  text: string;
  buttons: ApprovalButton[][];
  correlationId?: string;
}

export interface SentMessage {
  messageId: string;
  chatId: string;
}

export interface CallbackAck {
  callbackQueryId: string;
  text?: string;
}

export interface EditMessage {
  chatId: string;
  messageId: string;
  text: string;
  /** Removing the buttons is what stops a second tap on an already-decided card. */
  removeButtons?: boolean;
}

export interface TelegramAdapter {
  readonly name: string;
  send(card: ApprovalCard): Promise<Result<SentMessage, AppFailure>>;
  acknowledge(ack: CallbackAck): Promise<Result<void, AppFailure>>;
  edit(message: EditMessage): Promise<Result<void, AppFailure>>;
}

/** Telegram's hard limits, enforced before a request leaves the process. */
export const TELEGRAM_LIMITS = {
  messageChars: 4096,
  callbackDataBytes: 64,
} as const;
