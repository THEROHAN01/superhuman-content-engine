# Publishing

Publishing is the only stage that touches the outside world under Rohan's name, so it is guarded
three times over.

```
content_item (approved)
  -> POST /content-items/:id/schedule   { scheduled_at }
     1. refuse unless the item is approved
     2. decide dry run vs live
     3. claim the slot in the database (unique idempotency key)
     4. call the provider
     5. store the provider id, move the item to scheduled
  -> POST /publications/:id/mark-published   (worker or operator, once the slot passes)
  -> POST /publications/:id/cancel           (before it goes out)
```

## The three guards

1. **Approval is not advisory.** Only `approved` (or already `scheduled`) items are sent. A
   withdrawn approval (`approved -> rejected`) blocks publishing again.
2. **Live mode needs two independent yeses.** A live send requires `PUBLISH_MODE=live` _and_ a
   provider that can actually reach a platform (`adapter.simulated === false`). Configuration
   validation additionally refuses `PUBLISH_MODE=live` unless `PUBLISHING_PROVIDER=postiz`, and a
   Claude bash hook blocks commands that set live mode. Everything else is a dry run, stored with
   `dry_run = true`, and a dry run is never counted as published content.
3. **The slot is claimed before the provider is called.** `publications.idempotency_key` is
   `sha256(item id + platform + scheduled_at)` with a unique index. The row is inserted _first_;
   only the caller that wins the insert calls the provider. A crash between the two leaves a
   claimed row to reconcile, never an untracked post.

## Idempotency in practice

| Situation                          | Result                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Same item, same slot, called twice | second call returns the first publication, no provider call                            |
| Three concurrent calls             | exactly one row, one provider call (test asserts it)                                   |
| Same item, different slot          | a separate publication - rescheduling is legitimate                                    |
| Retry after a transient failure    | the claimed row is reused; attempts increments                                         |
| Provider redelivery                | the adapter also passes `Idempotency-Key`, so a well-behaved provider deduplicates too |

## Failure model

| Provider outcome                         | Publication status                | Retryable |
| ---------------------------------------- | --------------------------------- | --------- |
| success                                  | `scheduled`                       | -         |
| network error, timeout, 429, 5xx         | `retry_pending` with `last_error` | yes       |
| 4xx, malformed body, accepted-without-id | `failed` with `last_error`        | no        |

Retries are bounded with exponential backoff and honour `Retry-After`. Every failure writes an
`error_events` row, so a stuck publication is visible rather than silent. An "accepted but no id"
response is treated as a hard failure on purpose: without the provider's id, a later retry cannot
tell "already posted" from "never posted".

## Providers

| Provider         | Simulated | Notes                                                                                                                   |
| ---------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mock` (default) | yes       | in-memory, deduplicates by idempotency key, returns `https://mock.invalid/...` URLs (RFC 2606 reserved, cannot resolve) |
| `postiz`         | no        | `POST {base}/public/v1/posts`, `DELETE {base}/public/v1/posts/{id}`, API key in the `Authorization` header              |
| `failing`        | yes       | always fails; used for retry and dead-letter drills                                                                     |

The Postiz request shape is **assumed, not verified** against a live instance - see
`docs/external-apis.md`. It is isolated in one file so verification touches a single place.

## Going live (operator checklist)

1. Verify the Postiz contract against your instance with a test post.
2. Set `PUBLISHING_PROVIDER=postiz`, `POSTIZ_BASE_URL`, `POSTIZ_API_KEY`.
3. Leave `PUBLISH_MODE=dry_run` and run the whole pipeline once; confirm publications are recorded
   with `dry_run = true` and sensible payloads.
4. Only then set `PUBLISH_MODE=live`, and watch the first publication end to end.
