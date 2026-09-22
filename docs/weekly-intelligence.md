# Weekly intelligence

Once a week the engine reports what it did, what performed, what is stuck, and what to consider
next. Two properties matter more than the contents: it is **reproducible** (every number comes from
a query over stored rows) and it is **honest** (unknown metrics stay unknown, small samples are
labelled low confidence, and nothing is presented as causal).

```
worker (weekly_report job)  ->  generate  ->  store  ->  deliver via Telegram
API: POST /reports/weekly { deliver? } | GET /reports/weekly/:id[?format=text] | GET /reports/weekly
```

Version: `weekly.v1`. Window: the ISO week in `TZ`, keyed as `2026-W39`.

## What it contains

| Section                                   | Contents                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| counts                                    | learning events (and duplicates), atoms, ideas, drafts, gate passes/rejections, approvals, human rejections, publications, publication failures |
| capture to publish                        | median hours from capture to publication, `null` when nothing published                                                                         |
| by topic / format / platform / hook class | published count, impressions, engagements, engagement rate, and **how many publications were actually measured**                                |
| signals                                   | strongest and weakest groups, each with the basis it was drawn from and a confidence                                                            |
| failures                                  | grouped `error_events` for the week                                                                                                             |
| approval backlog                          | items waiting, how long, and their gate verdict                                                                                                 |
| next week                                 | 3-5 content opportunities from queued ideas, and learning topics where captured material is going unused                                        |

## Honesty rules

1. **Unknown stays unknown.** A group whose publications have no analytics reports `impressions:
null` and `engagement_rate: null`, never zero. The rendered report prints "impressions unknown".
2. **`measured` is always shown.** A rate computed from one post and a rate computed from twenty
   look identical otherwise.
3. **No winner from a thin sample.** Topic ranking needs at least two measured publications per
   group; below that the report says so, and states how many publications had known impressions and
   how many groups reached the minimum.
4. **Confidence is stated.** Fewer than five measured publications behind a signal is `low`.
5. **No causal claims.** Signals say "drew the most engagement per impression this week", not "this
   topic performs better".
6. **Suggestions are suggestions.** The report ends by saying so, and nothing it contains schedules
   or publishes anything.

## Hook classes

Hooks are grouped so openings can be compared without reading each one: `confession`, `question`,
`number`, `imperative`, `mechanism`, `statement`.

## Idempotency and history

`(period_key, generator_version)` is unique. Regenerating mid-week refreshes the same report -
more data has arrived, and five near-identical reports would be noise. A generator version bump
produces a genuinely new report for the same week, so old reports stay interpretable.

Reports are stored artifacts, not views: the numbers they quote stay as they were when sent, even
as later analytics collection changes the underlying rows. Earlier weeks remain readable through
`GET /reports/weekly`.

## Delivery

Generation and delivery are separate. If Telegram is down, the report still exists with
`status: failed` and `delivery_error` recorded; retrying sends the same report rather than
recomputing a different one. A delivered report is not re-sent.
