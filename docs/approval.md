# Approval loop

Nothing becomes publishable without a recorded human decision. The loop runs over Telegram, with
an API fallback for when the bot is unavailable.

```
content_item (gated, gate verdict pass|needs_review)
   -> POST /content-items/:id/request-approval   -> card sent, status pending_approval
   -> operator taps a button in Telegram
   -> POST /webhooks/telegram                    -> decision recorded, status updated, card edited
```

## The card

Shows the format and platform, the idea title, the draft itself, the quality-gate verdict with
every reason, the source links, and the content id. Four buttons: Approve, Reject, Regenerate,
Request change.

## Callback payload

`sce:<action code>:<content item id>:<version>` - about 40 bytes, inside Telegram's 64-byte
`callback_data` limit. The item reference travels in the payload because that is the only thing
Telegram returns to the webhook.

The **action id** is derived deterministically from `(item id, version, action)` and is the
idempotency key. Two independent uniqueness rules protect a decision:

| Key                               | Protects against                      |
| --------------------------------- | ------------------------------------- |
| `approvals.action_id`             | double-tapping the same button        |
| `(channel, external_callback_id)` | Telegram redelivering the same update |

A replay returns the original decision with `applied: false` instead of erroring, so the client
converges. A button from an older version fails with `E_STALE_ACTION`; the operator sees "that card
is out of date".

## Actions

| Action            | Effect                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `approve`         | `pending_approval -> approved`. Only approved items can be scheduled.                    |
| `reject`          | `pending_approval -> rejected`. A later approval of the same item is refused.            |
| `regenerate`      | creates version N+1 and supersedes N; the judged version and its decision stay on record |
| `request_change`  | records the note, leaves the item pending                                                |
| `schedule_review` | records the decision for a later look                                                    |

## Security

- Every inbound update must carry `X-Telegram-Bot-Api-Secret-Token`, compared in constant time
  against `TELEGRAM_WEBHOOK_SECRET`. Without it, the request is rejected with 401.
- Updates are recorded in `webhook_deliveries` before processing, so redeliveries are visible.
- Malformed updates get a 200 (so Telegram stops retrying) plus an `error_events` row.
- The bot token appears only in the request URL; a test asserts it never reaches a request body,
  an error object, or a stored failure detail.
- The callback is always answered - an unanswered callback query spins forever in the client - and
  the card is edited to remove its buttons once a decision lands.

## Operating the bot

```bash
# one-time, with a public HTTPS URL
TELEGRAM_PROVIDER=telegram WEBHOOK_URL=https://<host>/webhooks/telegram pnpm --filter @sce/bot bot set-webhook

# local development without a public URL: long-poll and forward to the local API
TELEGRAM_PROVIDER=telegram pnpm --filter @sce/bot bot poll
```

Polling forwards each update to the same webhook endpoint with the same secret header, so both
paths share one implementation of authentication, idempotency and state transitions.

## Fallback

`POST /content-items/:id/decide` applies the same decision through the API using the same
deterministic action id. It exists for CLI use, for tests, and for the case where Telegram is down
and content still needs a decision.
