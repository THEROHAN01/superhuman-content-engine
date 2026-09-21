# Milestone 12 - Human approval with Telegram

**STATUS: COMPLETE**

**OBJECTIVE:** Create a mobile approval loop before anything reaches publishing.

## WHAT I BUILT

A Telegram approval loop where every decision is recorded exactly once - protected by two
independent uniqueness rules - and where regeneration creates a new version instead of editing the
one a human judged. Plus an API fallback path, a bot helper for webhook registration and
development polling, and a mock adapter that enforces the same limits as the real one.

## TASKS COMPLETED

| #   | Atomic task                                    | Result                                                                                                    |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Bot/token setup documentation                  | `docs/approval.md` + `apps/bot` commands                                                                  |
| 2   | Inbound command parsing                        | zod-validated Telegram update schema                                                                      |
| 3   | Approval actions                               | approve, reject, regenerate, request_change, schedule_review                                              |
| 4   | Content preview message                        | `renderApprovalCard`, capped to Telegram's 4096 chars                                                     |
| 5   | Platform and source references in the preview  | format, platform, version, source URLs                                                                    |
| 6   | Quality-gate result in the preview             | verdict, score, gate version, every reason                                                                |
| 7   | Content id in the preview                      | shown as a code block for copy/paste                                                                      |
| 8   | Stable action ids                              | `sha256(item, version, action)` truncated to 32 hex chars                                                 |
| 9   | Protection against duplicate callback delivery | unique `action_id` _and_ unique `(channel, external_callback_id)`; a replay returns the original decision |
| 10  | Store every approval decision                  | append-only `approvals` rows                                                                              |
| 11  | Link decision to content version               | `content_item_version` on every approval                                                                  |
| 12  | Regenerate action                              | creates version N+1 through the generator                                                                 |
| 13  | Regeneration preserves history                 | the judged version becomes `superseded` with its draft and its decision intact (asserted)                 |
| 14  | Reject blocks publishing                       | status `rejected`; a later approval is refused with `E_ITEM_NOT_PENDING`                                  |
| 15  | Approve moves content to publishable state     | status `approved`; only `approved` can be scheduled                                                       |
| 16  | Handle expired/unknown action ids safely       | `E_UNKNOWN_ACTION` / `E_STALE_ACTION` / missing item all answer "that card is out of date"                |
| 17  | Test bot/sandbox mode                          | `createMockTelegramAdapter` records cards, acks and edits, and enforces the real limits                   |
| 18  | End-to-end approve/reject/regenerate tests     | covered in `approval.test.ts` and `telegram.test.ts`, plus a live drill                                   |

## FILES CREATED

`packages/adapters/src/telegram/{types,mock,telegram,index}.ts` + `telegram.test.ts`;
`packages/db/src/repositories/approvals.ts`; `packages/core/src/approval.ts` + `approval.test.ts`;
`apps/api/src/routes/telegram.ts` + `apps/api/src/telegram.test.ts`; `apps/bot/src/main.ts`;
`docs/approval.md`.

## FILES MODIFIED

`packages/adapters/src/index.ts`, `packages/db/src/index.ts`, `packages/core/src/index.ts`,
`apps/api/src/app.ts`, `apps/bot/package.json`, `eslint.config.js`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify       # 397 tests
bash /tmp/live-approval.sh              # gate -> card -> callback -> redelivery
```

## TEST RESULTS

397 passed. Approval coverage: callback encoding (deterministic, version-scoped, inside the
64-byte limit, round-trip, forged payloads rejected), card contents, refusal to send rejected or
already-pending items, Telegram outage leaving the item gated, approve/reject/regenerate/
request_change, duplicate delivery, three concurrent presses recording one decision, stale-version
button, unknown action, card length. The webhook suite adds secret-token authentication, malformed
updates, unrecognised buttons, redelivery, the API fallback, and the invariant that an item cannot
reach `approved` without a decision.

**A design defect was found during review and fixed:** the first webhook implementation needed an
`x-sce-item-id` header to know which item a button belonged to - something real Telegram callbacks
never send. The callback payload now carries the item id and version
(`sce:<code>:<item>:<version>`, ~40 bytes), so the webhook is self-contained and a button cannot
decide a version it was not rendered for.

## MANUAL VERIFICATION

```
$ curl -X POST .../content-items/it_.../request-approval -d '{}'
  {'status': 'pending_approval', 'message_id': 'mock-msg-1', 'unchanged': False}

$ curl -X POST .../webhooks/telegram -d '{...,"data":"sce:ap:it_0mubr9w85620ee2fbb2234060:1"}'
{ "ok": true, "action": "approve", "applied": true, "status": "approved" }

$ # exact same update delivered again
  {'action': 'approve', 'applied': False, 'status': 'approved'}

$ psql -> approvals stored: 1
$ psql -> item status: approved
```

## SECURITY REVIEW

- Constant-time comparison of the Telegram secret token; 401 on mismatch, with no detail leaked.
- The bot token appears only in the request URL - a test asserts it never appears in a request
  body, an error object, or a stored failure detail.
- Every update is recorded in `webhook_deliveries` before processing; redeliveries are recognised.
- Malformed updates return 200 with an `error_events` row, so Telegram stops retrying while the
  failure stays visible.
- Callback data is validated against a strict pattern; a forged or truncated payload is answered
  politely and ignored.
- The status transition table makes `approved` reachable only from `pending_approval`, so no code
  path can promote content without a decision (asserted).

## KNOWN LIMITATIONS

1. Not exercised against the real Telegram API - no bot token here. The adapter is covered by
   fake-`fetch` tests for success, 400, 429 with `retry_after`, 5xx, timeout and oversized callback
   data; the contract is documented in `docs/external-apis.md`.
2. `schedule_review` records the decision but has no scheduler behind it yet; that arrives with
   publishing (Milestone 13) and the worker.
3. `request_change` stores the note but does not yet feed it back into regeneration as an
   instruction - doing that well needs a prompt version that accepts editorial feedback.
4. The approval card shows the first 1200 characters of a draft; long LinkedIn posts are truncated
   in the preview (the full text is always available through `GET /content-items/:id`).

## ACCEPTANCE CRITERIA

| Criterion                                                     | Evidence                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Only approved content can enter publishable state             | transition table asserted: a direct promotion from `gated` to `approved` is refused                                         |
| Every decision is stored                                      | append-only approvals with actor, channel, version and timestamp; live run stored exactly one                               |
| Duplicate Telegram actions do not cause duplicate transitions | redelivery returned `applied: false`; three concurrent presses produced one row; two unique keys enforce it in the database |
| Regeneration preserves history                                | the judged version is superseded with its draft and decision intact, and the new version is separate                        |

## RECOMMENDED NEXT MILESTONE

13 - Publishing and scheduling adapter.
