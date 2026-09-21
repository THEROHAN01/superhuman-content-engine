# Milestone 04 - Learning Inbox and capture API

**STATUS: COMPLETE**

**OBJECTIVE:** Capture daily learning with minimum friction.

## WHAT I BUILT

A Fastify API whose capture endpoint needs one field, stores the note verbatim, and is safe to
call repeatedly: a duplicate returns the original event with `200` instead of creating a second
row. Around it: correlation ids on every request, bearer authentication, rate limiting, a uniform
error shape, liveness/readiness probes, and the `captureLearningEvent` service in `@sce/core` that
records a `workflow_runs` row for every capture and an `error_events` row for every failure.

## TASKS COMPLETED

| #   | Atomic task                                    | Result                                                                                                                           |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Minimal input contract                         | `captureLearningEventInput` - `text` required, everything else optional                                                          |
| 2   | POST/webhook intake                            | `POST /capture`                                                                                                                  |
| 3   | Telegram intake command                        | deferred to Milestone 12 (Telegram transport); `source: 'telegram'` + `external_id` already deduplicate correctly and are tested |
| 4   | Validate required fields                       | zod at the boundary; `422` with per-field issues                                                                                 |
| 5   | Trim/normalize input                           | trimmed on the contract; deeper normalization is Milestone 06                                                                    |
| 6   | Unique learning event id                       | `le_` prefixed, time-ordered                                                                                                     |
| 7   | Store original raw input unchanged             | `raw_text` stored verbatim (test asserts byte equality)                                                                          |
| 8   | Store capture source and timestamp             | `source`, `captured_at`, `context`                                                                                               |
| 9   | Human-readable confirmation                    | `message` field, distinct wording for new vs duplicate                                                                           |
| 10  | GET retrieval                                  | `GET /learning-events/:id`                                                                                                       |
| 11  | Update/status support                          | `advanceStatus` in the repository with monotonic transitions (used from Milestone 06)                                            |
| 12  | Reject malformed requests usefully             | `E_INVALID_CAPTURE` + `details.issues`                                                                                           |
| 13  | Authentication for non-local endpoints         | bearer token, constant-time compare; env validation makes a non-loopback bind without a token impossible                         |
| 14  | Request correlation id                         | generated or accepted from `x-correlation-id`, echoed, stored on the row, logged                                                 |
| 15  | Automated tests for valid and invalid payloads | 16 API tests                                                                                                                     |
| 16  | End-to-end capture smoke test                  | real server + curl, output below                                                                                                 |

## FILES CREATED

`packages/core/src/{context,capture,index}.ts`;
`apps/api/src/{app,server}.ts`, `apps/api/src/plugins/{correlation,auth,error-handler}.ts`,
`apps/api/src/routes/{health,capture}.ts`, `apps/api/src/capture.test.ts`; `docs/api.md`.

## FILES MODIFIED

`packages/db/src/repositories/learning-events.ts` - **bug fix** (see below);
`packages/db/src/index.ts` - export the test harness.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm vitest run apps/api     # 16 tests
TEST_DATABASE_URL=... pnpm verify                  # full suite
# live server on :8099 against sce_dev, exercised with curl
```

## TEST RESULTS

All green. The API suite covers: single event per note, verbatim text, idempotent repeat,
provider redelivery by external id, invalid payload, unknown source, correlation id generation and
propagation, workflow-run recording, retrieval, 404, listing + status validation, health probes,
unknown route, and four authentication cases.

**A test found a real bug.** The insert used `ON CONFLICT (content_hash) ... DO NOTHING`, which
handles only one of the two uniqueness rules: a Telegram redelivery with the same `external_id`
but edited text raised a unique violation instead of returning the original event. Fixed by using
a bare `ON CONFLICT DO NOTHING` and resolving the existing row by either rule. The redelivery test
now passes.

## MANUAL VERIFICATION

```
$ curl localhost:8099/health/ready
{"status":"ready","checks":{"database":{"ok":true,"detail":"15ms"}},
 "config":{"publish_mode":"dry_run","llm_provider":"mock",...}}

$ curl -X POST localhost:8099/capture -d '{"text":"Today I learned that SKIP LOCKED ..."}'
{"id":"le_0mubp7kfz3326d3bcc2504a6e","status":"received","duplicate":false,
 "message":"Captured le_0mubp7kfz...: \"Today I learned that SKIP LOCKED ...\""}

$ # same request again
{"id":"le_0mubp7kfz3326d3bcc2504a6e","duplicate":true,
 "message":"Already captured as le_0mubp7kfz... - nothing new was created."}

$ curl -X POST localhost:8099/capture -d '{"text":"nope"}'      -> 422
{"error":{"code":"E_INVALID_CAPTURE","details":{"issues":[{"path":"text",
 "message":"a learning note needs at least 10 characters"}]}}}

$ for i in $(seq 1 125); do curl -o /dev/null -w "%{http_code}\n" .../learning-events; done | sort | uniq -c
    117 200
      8 429          # rate limiting active

$ grep -c "password\|DATABASE_URL" /tmp/api.log   ->  0
```

## SECURITY REVIEW

- Bearer token compared with `safeEqual` (constant time); 401 body reveals nothing about the token.
- Body size limited (`API_BODY_LIMIT_BYTES`, default 256 KiB) and per-IP rate limiting enabled;
  health probes are allow-listed so a flood cannot hide an outage.
- Internal errors return `E_INTERNAL` with no message detail; the real error is logged with the
  correlation id only.
- Server logs verified free of credentials (grep above); `DATABASE_URL` is in the redaction list.
- `trustProxy: false` - client IPs are not spoofable through headers in this deployment shape.

## KNOWN LIMITATIONS

1. Telegram and Notion intake paths are stubs at the contract level only; the transports arrive in
   Milestones 12 and (optionally) later.
2. Rate limiting is in-process. With more than one API instance it should move to the Redis store;
   noted for Milestone 17.
3. Capture does not yet trigger normalization - that pipeline step is Milestone 06.

## ACCEPTANCE CRITERIA

| Criterion                                         | Evidence                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A short note creates exactly one learning event   | test asserts one row; curl shows `201` then `200`                                                       |
| Original text is preserved                        | test compares stored `raw_text` byte-for-byte                                                           |
| Malformed inputs fail safely                      | `422` with field-level issues; no row written                                                           |
| Repeated requests can be detected or deduplicated | duplicate returns the original id with `duplicate: true`; database-level unique indexes back both rules |
| Retrieval returns the stored event and metadata   | `GET /learning-events/:id` returns the full row including hash, correlation id and timestamps           |

## RECOMMENDED NEXT MILESTONE

05 - n8n orchestration foundation.
