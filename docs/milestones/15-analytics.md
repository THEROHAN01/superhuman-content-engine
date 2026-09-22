# Milestone 15 - Analytics collection and normalization

**STATUS: COMPLETE**

**OBJECTIVE:** Connect published content to performance data.

## WHAT I BUILT

A collection stage that treats missing data honestly - unknown metrics stay null from the adapter
through storage into derived ratios - plus the durable job runner that will carry every scheduled
job from here on.

## TASKS COMPLETED

| #   | Atomic task                                                       | Result                                                                                                                              |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Normalized analytics schema                                       | 9 nullable metrics, per-platform capability map                                                                                     |
| 2   | Immutable publication record                                      | publications from Milestone 13; analytics reference them, never rewrite them                                                        |
| 3   | Store platform, post id, topic, format, hook, published timestamp | reachable through `publication -> content_item -> idea -> atom`; analytics carry platform, publication, item and learning event ids |
| 4   | Identify available platform metrics                               | `PLATFORM_METRICS`; anything outside a platform's set is dropped                                                                    |
| 5   | Provider-specific metric adapters                                 | `mock` (deterministic, simulated), `postiz` (defensive mapping), `failing`                                                          |
| 6   | Normalize common fields                                           | impressions, reach, reactions, comments, shares, saves, clicks, profile actions, video views                                        |
| 7   | Store the raw provider payload separately                         | `raw_payload`, never used for computation                                                                                           |
| 8   | Record retrieval timestamp                                        | `collected_at`, distinct from `collected_for` (the day described)                                                                   |
| 9   | Handle missing metrics without zeroing them                       | null everywhere; the mock deliberately leaves a supported metric unknown so the null path is always exercised                       |
| 10  | Scheduled collection workflow                                     | `collect_analytics` job + `apps/workers` runtime                                                                                    |
| 11  | Retry/backoff                                                     | `withRetry` in the service, growing backoff plus a dead state in the job runner                                                     |
| 12  | Prevent duplicate analytics records                               | `(publication, window, day)` unique; a repeat refreshes the row                                                                     |
| 13  | Calculate derived metrics only when denominators exist            | `deriveMetrics` returns null ratios without a positive denominator                                                                  |
| 14  | Link analytics back to content item and source atom               | both ids stored; a join test walks analytics back to the learning event                                                             |
| 15  | Test fixtures                                                     | deterministic mock metrics; scripted provider responses in adapter tests                                                            |
| 16  | Verify collection survives provider failure                       | failing provider writes an error row and stores nothing; a sweep reports failures and continues                                     |

## FILES CREATED

`packages/adapters/src/analytics/{types,mock,postiz,index}.ts` + `analytics.test.ts`;
`packages/db/src/repositories/{analytics,jobs}.ts`;
`packages/core/src/analytics.ts` + `analytics.test.ts`;
`apps/workers/src/{runtime,main}.ts`, `apps/workers/src/jobs/collect-analytics.ts`,
`apps/workers/src/runtime.test.ts`; `apps/api/src/routes/analytics.ts`; `docs/analytics.md`.

## FILES MODIFIED

`packages/adapters/src/index.ts`, `packages/db/src/index.ts`, `packages/core/src/{index,publish}.ts`,
`apps/api/src/app.ts`, `apps/workers/package.json`, `eslint.config.js`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify      # 516 tests
bash /tmp/live-analytics.sh            # full chain to analytics, then the worker
```

## TEST RESULTS

516 passed. Analytics coverage: derived metrics (null denominator, zero denominator, reach
fallback, unknown-vs-zero distinction), collection with provenance, per-platform metric sets,
determinism, refresh-not-duplicate, separate rows per window and day, provider failure storing
nothing, refusals (no provider id, cancelled, unknown), raw payload retention, sweeps with and
without failures, and a provenance join. Worker coverage: run, empty queue, duplicate enqueue,
re-enqueue after completion, retry then dead, unknown job type, two workers never sharing a job,
stale-lock release, queue drain, recurring schedule idempotency.

**A real robustness gap surfaced while writing these tests.** A provider returning an external id
already recorded against another publication raised a raw Postgres unique-violation that escaped
the service, leaving the publication stuck in `pending` with no error row. It is now caught
explicitly: the publication fails with `E_PUBLISH_DUPLICATE_EXTERNAL_ID`, the reason is stored, and
an error row is written - because two publications claiming one post is exactly the confusion this
system exists to prevent.

## MANUAL VERIFICATION

```
$ curl -X POST .../publications/pb_.../collect-analytics -d '{"window":"24h"}'
  inserted: True | simulated: True
  metrics : {'impressions': 1506, 'reach': None, 'reactions': 5, 'comments': 5, 'shares': 10,
             'saves': None, 'clicks': None, 'profile_actions': None, 'video_views': None}
  derived : {'engagement_rate': 0.01328, 'comment_rate': 0.00332, 'save_rate': None}

$ # same day again ->  inserted: False        (refreshed, not duplicated)
$ # 7d window       ->  inserted: True, impressions: 6858
$ psql -> analytics rows: 2

$ psql -> {"reach": null, "saves": null, ..., "impressions": 1506}   # nulls, not zeroes

$ # worker
{"msg":"scheduled analytics collection","enqueued":true,"period":"2026-09-22"}
{"msg":"worker started","handlers":["collect_analytics"]}
{"msg":"job completed","job_type":"collect_analytics","result":{"attempted":1,"collected":1,"failed":[]}}
```

## SECURITY REVIEW

- The Postiz API key travels only in the `Authorization` header; a test asserts it never appears in
  an error.
- Raw provider payloads are stored for traceability but never interpreted as instructions and never
  used for computation.
- Analytics endpoints sit behind the operator bearer token.
- The job runner never logs payload contents beyond what a handler returns, and handler results are
  small summaries rather than provider data.

## KNOWN LIMITATIONS

1. The Postiz analytics contract is **assumed**; the mapping is defensive (unknown fields stay
   null) and the raw payload is kept so a corrected mapping can be backfilled.
2. Collection is pull-based on a daily schedule. Platforms that only expose lifetime counters will
   need per-day differencing, which is easier once real data exists to test against.
3. `collected_for` is a UTC day. With `TZ=Asia/Kolkata` the reporting day boundary and the
   collection day boundary differ by 5.5 hours; the weekly report (Milestone 16) computes its
   window in the configured timezone, so this only affects which day a metric is filed under.
4. No alerting on a publication that never receives analytics; the health and reliability milestone
   covers stalled-state sweeps.

## ACCEPTANCE CRITERIA

| Criterion                                        | Evidence                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Published content can receive analytics records  | live chain collected for a published publication with metrics and derived ratios                                            |
| Unknown metrics remain unknown, not falsely zero | stored JSON shows nulls; `deriveMetrics` returns null ratios; a test distinguishes unknown from measured zero               |
| Provider-specific data is traceable              | `provider`, `raw_payload`, `collected_at` and `collected_for` all stored                                                    |
| Repeated collection is safe                      | same day refreshes in place (`inserted: false`), different window/day creates a separate row; unique constraint enforces it |

## RECOMMENDED NEXT MILESTONE

16 - Weekly content intelligence.
