# Milestone 16 - Weekly content intelligence

**STATUS: COMPLETE**

**OBJECTIVE:** Turn accumulated learning, publishing and analytics data into useful weekly
decisions.

## WHAT I BUILT

A weekly report that is reproducible from stored rows and honest about what it does not know:
counts across the whole pipeline, performance grouped four ways with the measured-sample size
attached, signals that refuse to rank thin samples, failures, approval backlog, and suggestions
for next week - stored as an artifact and delivered over Telegram.

## TASKS COMPLETED

| #   | Atomic task                                             | Result                                                                                                                 |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Define the reporting window and timezone                | ISO week in `TZ`, keyed `YYYY-Www`; stored with the report                                                             |
| 2   | Calculate learning events                               | plus duplicates, counted separately                                                                                    |
| 3   | Calculate content ideas created                         | in-window count                                                                                                        |
| 4   | Calculate drafts generated                              | plus gate passes and gate rejections                                                                                   |
| 5   | Calculate approved/published items                      | approvals by action, publications by status                                                                            |
| 6   | Time from capture to publish                            | median hours, `null` when nothing published                                                                            |
| 7   | Group performance by topic                              | with impressions, engagements, rate and measured count                                                                 |
| 8   | Group by format                                         | same shape                                                                                                             |
| 9   | Group by platform                                       | same shape                                                                                                             |
| 10  | Group by hook class                                     | six deterministic classes                                                                                              |
| 11  | Identify strongest/weakest signals without overclaiming | ranking requires 2+ measured publications per group; confidence is `low` below 5; wording is comparative, never causal |
| 12  | Surface publishing failures                             | grouped `error_events` for the week                                                                                    |
| 13  | Surface approval backlog                                | items waiting, hours waited, gate verdict                                                                              |
| 14  | 3-5 content opportunities for next week                 | highest-scoring queued ideas with their rationale                                                                      |
| 15  | 3-5 learning-topic suggestions                          | topics with captured-but-unpublished material over 4 weeks                                                             |
| 16  | Store the weekly report                                 | `weekly_reports`, unique per (period, generator version)                                                               |
| 17  | Send the report through Telegram                        | separate delivery step, idempotent, failure recorded without losing the report                                         |
| 18  | Seeded test data for a fake week                        | `seedChain` builds full chains with controllable timestamps and metrics                                                |
| 19  | Verify totals against underlying data                   | a test compares report counts with direct SQL counts                                                                   |

## FILES CREATED

`packages/db/migrations/0002_weekly_reports.sql`;
`packages/db/src/repositories/weekly-reports.ts`;
`packages/core/src/weekly-report.ts` + `weekly-report.test.ts`;
`apps/workers/src/jobs/weekly-report.ts`; `apps/api/src/routes/reports.ts`;
`docs/weekly-intelligence.md`.

## FILES MODIFIED

`packages/schemas/src/{operations,enums}.ts`, `packages/db/src/index.ts`,
`packages/core/src/index.ts`, `apps/api/src/app.ts`, `apps/workers/src/main.ts`,
`packages/db/src/{migrations,enum-parity}.test.ts` (the schema change-detectors).

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify     # 541 tests, exit 0
bash /tmp/live-weekly.sh              # two full chains, report, delivery, regeneration
```

## TEST RESULTS

541 passed. Weekly coverage: ISO week keys and windows, hook classification, window boundaries
(older chains excluded), reconciliation against direct SQL counts, unknown metrics staying unknown,
refusal to name a winner from one measured post, ranking with basis and confidence when data
allows, grouping by format/platform/hook, capture-to-publish latency (and its absence), approval
backlog and unused-material suggestions, regeneration refreshing rather than duplicating, earlier
weeks remaining accessible, rendering (including "impressions unknown"), idempotent delivery,
delivery failure preserving the report, and a valid empty report for a quiet week.

**Two defects were found and fixed during this milestone:**

1. The gaps query used an untyped parameter in interval arithmetic, so report generation failed
   with `operator does not exist: timestamp with time zone >= interval`. Because the service
   records failures rather than throwing, this surfaced as a clean `E_REPORT_FAILED` - the fix was
   an explicit `::timestamptz` cast. The same code path also classified that failure as `transient`
   in the stored error row but `permanent` in its return value; both now say transient.
2. Live output claimed "0 topic group(s) with usable metrics" while the report itself showed a
   topic with an engagement rate. The group had metrics, just not _enough_ of them. The basis now
   states publications with known impressions and how many groups reached the minimum - in a report
   whose whole point is honesty, a misleading basis line is a real defect.

## MANUAL VERIFICATION

```
$ curl -X POST .../reports/weekly -d '{"deliver":true}'
  period: 2026-W39 | tz: Asia/Kolkata | inserted: True | delivery: {'delivered': True}
  counts: {learning_events: 2, content_atoms: 2, content_ideas: 4, drafts_generated: 2,
           approved: 2, published: 2, publications_failed: 0, ...}
  signal [low]  not enough measured publications to compare topics this week
  signal [high] 1 published item(s) have no analytics yet

$ curl '.../reports/weekly/wr_...?format=text'
By topic
  backend: 1 published, 1506 impressions, rate 0.01328
  databases: 1 published, impressions unknown          <- unknown, not zero

$ # regenerate ->  inserted: False
$ psql -> db: learning_events=2 atoms=2 published=2 reports=1     (report counts match exactly)
```

## SECURITY REVIEW

- The report is computed entirely from stored rows; it makes no external call except delivery.
- Delivery goes through the same Telegram adapter, so the bot token never leaves the adapter.
- Report routes sit behind the operator bearer token.
- `error_events` details are already redacted at write time; the report quotes only code and a
  truncated message.

## KNOWN LIMITATIONS

1. Signals compare groups within one week only. Week-over-week trends need several stored reports,
   which will exist after a few cycles - the data model supports it now.
2. `capture_to_publish_hours` is a median over publications in the window; with one or two
   publications it is really just "the value", which the small-sample caveat covers only
   implicitly.
3. Hook classification is a keyword heuristic. It is good enough to group openings for comparison,
   not to judge whether a hook is good.
4. The learning-topic suggestions look at unused captured material; they cannot see what Rohan is
   about to learn, so they are a prompt for reflection rather than a plan.

## ACCEPTANCE CRITERIA

| Criterion                             | Evidence                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Weekly report is reproducible         | derived entirely from stored rows; regenerating returns the same report id and refreshed counts; a test asserts stability           |
| Numbers reconcile with source records | a test compares every count against direct SQL, and group totals against the published count; live run matched the database exactly |
| Recommendations remain suggestions    | opportunities and learning topics are text only; the rendered report states explicitly that nothing here schedules or publishes     |
| Historical reports remain accessible  | unique per (period, version), never deleted; `GET /reports/weekly` listed both 2026-W38 and 2026-W39 in a test                      |

## RECOMMENDED NEXT MILESTONE

17 - Reliability, security, observability.
