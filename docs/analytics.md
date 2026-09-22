# Analytics

One rule shapes this whole stage: **unknown is not zero.** A metric a platform does not expose is
`null` in the adapter, `null` in the database, and `null` in every derived figure. A zero is a
measurement; a null is an admission, and conflating them corrupts every average silently.

```
publication (published, has a provider id)
  -> POST /publications/:id/collect-analytics { window }
     fetch -> normalize -> restrict to what the platform can report -> store
  -> GET /publications/:id/analytics    (metrics + derived ratios)
```

The worker enqueues `collect_analytics` once per day; the job sweeps every measurable publication.

## Normalized metrics

`impressions`, `reach`, `reactions`, `comments`, `shares`, `saves`, `clicks`, `profile_actions`,
`video_views` - all nullable.

Each platform declares what it can report, and anything outside that set is dropped even if a
provider offers a value:

| Platform  | Reports                                                           |
| --------- | ----------------------------------------------------------------- |
| X         | impressions, reactions, comments, shares, clicks, profile_actions |
| LinkedIn  | impressions, reactions, comments, shares, clicks                  |
| Instagram | reach, reactions, comments, shares, saves, video_views            |

## Derived metrics

Computed only when the denominator exists and is positive:

| Metric            | Formula                                                  | Null when                                                |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `engagement_rate` | (reactions + comments + shares) / (impressions or reach) | no denominator, or none of the three components is known |
| `comment_rate`    | comments / denominator                                   | comments unknown                                         |
| `save_rate`       | saves / denominator                                      | saves unknown                                            |

Unknown components are _skipped_, not treated as zero: a post with 10 known reactions and unknown
comments has the same engagement rate as one with 10 reactions and zero comments only if the zero
was actually measured.

## Idempotency

`(publication_id, metric_window, collected_for)` is unique. Collecting again on the same day
**refreshes** the row rather than adding one - metrics genuinely change during a day, and the
collection is identified by the day it describes, not by the moment it ran. A different window or a
different day is a different row.

## Failure handling

A provider failure writes an `error_events` row and stores **nothing**. There is no "collected
zeroes" state, because that would be indistinguishable from a post nobody saw. Transient failures
(timeout, 429, 5xx) retry with backoff; permanent ones (4xx, malformed body) stop.

Collection is refused outright when:

| Condition                                                  | Code                      |
| ---------------------------------------------------------- | ------------------------- |
| the publication has no provider id (nothing was ever sent) | `E_NO_EXTERNAL_ID`        |
| the publication is cancelled or failed                     | `E_NOT_PUBLISHED`         |
| the publication does not exist                             | `E_PUBLICATION_NOT_FOUND` |

A sweep records per-publication failures and continues; a partial collection is more useful than an
aborted one.

## Providers

Analytics follows the publishing provider - metrics come from wherever the post was published, so a
mock publication can only ever have mock metrics (`simulated: true` on every response). The Postiz
mapping is defensive: unrecognised fields stay null, and the raw payload is stored so a mapping can
be corrected retrospectively. That contract is **assumed**, not verified - see
`docs/external-apis.md`.

## Worker

`apps/workers` runs a durable queue on PostgreSQL (`jobs` table, `FOR UPDATE SKIP LOCKED`):

- one job claimed per transaction, so several workers never run the same job;
- a job whose worker dies is released by the stale-lock sweep;
- failures retry with growing backoff and become `dead` at the attempt budget, visible rather than
  retried forever;
- an unknown job type fails immediately - that is a deployment mistake, not a transient fault;
- recurring work is enqueued with the period in its dedupe key, so repeated scheduling is harmless
  and tomorrow's run is a separate job.
