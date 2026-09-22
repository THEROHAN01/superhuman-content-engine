# Milestone 13 - Publishing and scheduling adapter

**STATUS: COMPLETE**

**OBJECTIVE:** Schedule approved content through a publishing layer without coupling the entire
system to it.

## WHAT I BUILT

A publishing layer behind an adapter interface with three independent guards against the worst
failure this system could have - publishing something twice, or publishing something nobody
approved - plus a mock provider that is itself idempotent, a failing provider for drills, and the
Postiz implementation isolated in one file.

## TASKS COMPLETED

| #   | Atomic task                                 | Result                                                                                       |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Publishing adapter interface                | `PublishingAdapter`: `schedule`, `cancel`, `simulated`                                       |
| 2   | Post payload contract                       | `PublishPayload` with idempotency key, platform, body, units, slot                           |
| 3   | Schedule request contract                   | `POST /content-items/:id/schedule { scheduled_at }`                                          |
| 4   | Postiz sandbox/test setup                   | `mock` default; Postiz isolated in `postiz.ts`, contract documented as assumed               |
| 5   | Authentication from environment             | `POSTIZ_API_KEY` in the `Authorization` header; never logged                                 |
| 6   | Create/schedule operation                   | implemented, with `Idempotency-Key` also sent provider-side                                  |
| 7   | Capture external publication id             | stored; a response without an id is a hard failure                                           |
| 8   | Capture platform and scheduled timestamp    | on every publication row                                                                     |
| 9   | Deterministic idempotency key               | `sha256(item, platform, normalized slot)`; equivalent timestamps collide (tested)            |
| 10  | Verify status is APPROVED before publishing | `E_NOT_APPROVED` otherwise; withdrawn approvals blocked too                                  |
| 11  | Prevent duplicate submissions               | unique index claimed _before_ the provider call; concurrent callers produce one post         |
| 12  | Handle provider timeouts                    | `AbortSignal.timeout` + transient classification                                             |
| 13  | Handle rate limits                          | 429 is transient and honours `Retry-After`                                                   |
| 14  | Handle partial failures                     | `retry_pending` vs `failed`, with `last_error` and an `error_events` row                     |
| 15  | Store provider metadata without secrets     | adapter returns already-stripped metadata; a test asserts the API key never reaches an error |
| 16  | Cancellation/unschedule                     | `POST /publications/:id/cancel`, idempotent, refuses after publish                           |
| 17  | Create and schedule test content            | live drill below                                                                             |
| 18  | Verify re-running does not duplicate        | live drill + three-way concurrency test                                                      |
| 19  | Document provider limitations               | `docs/publishing.md`, `docs/external-apis.md`                                                |

## FILES CREATED

`packages/adapters/src/publishing/{types,mock,postiz,index}.ts` + `publishing.test.ts`;
`packages/db/src/repositories/publications.ts`; `packages/core/src/publish.ts` + `publish.test.ts`;
`apps/api/src/routes/publish.ts`; `docs/publishing.md`.

## FILES MODIFIED

`packages/adapters/src/index.ts`, `packages/db/src/index.ts`, `packages/core/src/index.ts`,
`apps/api/src/app.ts`, `packages/db/src/repositories/content-items.ts` (approval can be withdrawn
before scheduling).

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify      # 426 tests
bash /tmp/live-publish.sh              # approval guard, dry run, duplicate, publish, cancel
```

## TEST RESULTS

426 passed. Publishing coverage: schedule stores the provider id, refusal for never-approved and
for withdrawn-approval content, idempotent re-runs, three concurrent requests producing one post,
a different slot being a separate publication, dry-run default, live-mode-with-simulated-provider
still dry running, transient failure staying retryable, permanent failure marked failed, recovery
reusing the claimed row, cancel (idempotent, refused after publish), mark-published idempotent,
key derivation, invalid schedule time. Adapter coverage: mock idempotency and reserved domain,
Postiz request shape, thread units, missing id, 429/5xx/4xx classification with `Retry-After`,
timeout, API key never in an error, cancel-404 as success.

**A test exposed a real gap:** an item approved by mistake could not be rejected before it was
scheduled, because the transition table had no `approved -> rejected` edge. Withdrawing an
approval is a legitimate operator action, so that edge now exists (still not from `scheduled` or
`published`, where cancellation is the right tool), and both cases are covered by tests.

## MANUAL VERIFICATION

```
$ # before approval
  http 422 E_NOT_APPROVED

$ # after approval
  {'status':'scheduled','created':True,'dry_run':True,'provider':'mock',
   'external_id':'mock-post-1','attempts':1}

$ # same item, same slot, again
  {'status':'scheduled','created':False,'external_id':'mock-post-1'}
$ psql -> count=1 dry_run=true

$ # mark published twice
  {'status':'published','published_at':'2026-09-22T09:25:55.597Z','dry_run':True}
  {'status':'published','published_at':'2026-09-22T09:25:55.597Z'}    # unchanged

$ # cancel after publish
  http 422 E_ALREADY_PUBLISHED
$ psql -> item status: published
```

## SECURITY REVIEW

- The Postiz API key travels only in the `Authorization` header; a test asserts it never appears in
  an error object, and provider error bodies are truncated to 200 characters.
- Live publishing needs `PUBLISH_MODE=live` _and_ a non-simulated provider; configuration
  validation refuses live mode without a real provider, and a Claude hook blocks commands that set
  it. Three independent guards, all tested or asserted.
- Mock publications use `https://mock.invalid/...` (RFC 2606) so a simulated post can never be
  mistaken for a real URL.
- Provider metadata is stored as the adapter returns it, after the adapter has stripped anything
  secret; no raw response body is persisted.

## KNOWN LIMITATIONS

1. The Postiz contract is **assumed**, not verified against a live instance - no Postiz instance or
   credentials exist here. It is isolated in `postiz.ts`, defaults are mock, and
   `docs/publishing.md` carries an operator checklist that verifies it before live mode.
2. `mark-published` is called by an operator or the worker; nothing polls the provider for actual
   delivery confirmation yet. That belongs with analytics collection (Milestone 15), which will
   read provider state anyway.
3. Media attachments (carousel images, reel video) are not handled - only text. The payload has an
   `options` passthrough for provider hints when that arrives.
4. Retry of a `retry_pending` publication is manual today (re-issue the schedule request); the
   worker's retry sweep lands in Milestone 17.

## ACCEPTANCE CRITERIA

| Criterion                                           | Evidence                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Approved test content can be scheduled              | live drill scheduled an approved item, provider id stored, item moved to `scheduled`                                                      |
| Unapproved content is blocked                       | `E_NOT_APPROVED` for never-approved and for withdrawn-approval items; no provider call made                                               |
| Repeated execution is idempotent                    | second and third calls returned the same publication with `created: false`; one row, one post; concurrency test asserts the same          |
| External ID is stored                               | `external_id` and `external_url` on the publication, and a response without an id is a hard failure                                       |
| Provider errors produce recoverable workflow states | transient -> `retry_pending` (retryable, error row written), permanent -> `failed`; recovery reuses the claimed row without a second post |

## RECOMMENDED NEXT MILESTONE

14 - GitHub to content opportunities.
