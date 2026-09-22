# Milestone 17 - Reliability, security, observability

**STATUS: COMPLETE** (two checks require a Docker host; see limitations)

**OBJECTIVE:** Make the system safe to run repeatedly and diagnose when something breaks.

## WHAT I BUILT

Health that distinguishes _up_ from _making progress_, a recovery sweep that releases abandoned
work and dead-letters what has exhausted its budget, a backup drill that actually restores, a
failure-injection script, three operational n8n workflows, and an incident runbook written around
the failures this system can really have.

## TASKS COMPLETED

| #     | Atomic task                                 | Result                                                                                                                                                                   |
| ----- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Audit every secret and credential path      | audit run: no credential-shaped literals in tracked files, only `infra/.env.example` tracked, adapters keep credentials in headers, tests assert keys never reach errors |
| 2     | Confirm secrets absent from Git and logs    | `git grep` clean; pino redaction list covers authorization, tokens, keys and `DATABASE_URL`; CI has a secret-scan job                                                    |
| 3     | Input validation at every external boundary | zod on capture, pipeline, telegram, github, publish, analytics and report routes                                                                                         |
| 4     | Timeouts on external HTTP calls             | every adapter uses `AbortSignal.timeout`; audited - the only unguarded `fetch` identifiers are the adapters' own method names                                            |
| 5     | Retry with backoff                          | `withRetry` (transient only) plus growing backoff in the job runner                                                                                                      |
| 6     | Permanent vs retryable failure states       | typed `transient`/`permanent` throughout; `retry_pending` vs `failed` on publications; `pending` vs `dead` on jobs                                                       |
| 7     | Dead-letter state                           | publications past the attempt budget become `failed` with an `E_PUBLISH_EXHAUSTED` error row; jobs become `dead`                                                         |
| 8     | Correlation ids across workflows            | generated or accepted at every entry point, stored on rows, queryable via `/internal/runs` and `/internal/errors`                                                        |
| 9     | Structured logs for key transitions         | pino with redaction at every stage transition                                                                                                                            |
| 10    | Execution records for critical workflows    | `workflow_runs` written by capture, processing, research, atom build, ideation, generation, gate, approval, publish, analytics and report                                |
| 11    | Service health checks                       | compose health checks (Milestone 02) plus `/health/live` and `/health/ready`                                                                                             |
| 12    | System health workflow                      | `/health/system` (dependencies + stalls + recent errors) and `system_health_check_v1`                                                                                    |
| 13    | Failure notification path                   | every workflow routes failures to `/internal/errors`; the shared error workflow funnels n8n failures into the same table                                                 |
| 14    | Database backup procedure                   | `infra/scripts/backup.sh`                                                                                                                                                |
| 15    | Restore test procedure                      | `infra/scripts/backup-verify.sh` - dumps, restores into a scratch database, compares row counts table by table, drops the scratch                                        |
| 16-18 | Service / database / Redis restart tests    | documented drills; require a Docker host (limitation 1)                                                                                                                  |
| 19    | Provider outage test                        | `*_PROVIDER=failing` drills; live run below                                                                                                                              |
| 20    | Malformed input test                        | failure drill check 1 (422 with field-level issues)                                                                                                                      |
| 21    | Duplicate webhook test                      | failure drill checks 2-3; covered by tests for GitHub and Telegram                                                                                                       |
| 22    | Duplicate approval test                     | covered in Milestone 12 (two unique keys, concurrent presses)                                                                                                            |
| 23    | Duplicate publish test                      | covered in Milestone 13 (claimed slot, concurrency test)                                                                                                                 |
| 24    | Incident/recovery procedures                | `docs/incident-runbook.md`                                                                                                                                               |

## FILES CREATED

`packages/core/src/health.ts` + `health.test.ts`; `apps/workers/src/jobs/sweep.ts`;
`infra/scripts/{backup-verify,failure-drill}.sh`;
`n8n/workflows/{analytics_collect_v1,weekly_report_v1,system_sweep_v1}.json`;
`docs/incident-runbook.md`.

## FILES MODIFIED

`apps/api/src/routes/health.ts` (system health + sweep), `apps/workers/src/main.ts` (sweep job and
hourly schedule), `infra/scripts/generate-workflows.py`, `tests/infra/{compose,workflows}.test.ts`,
`docs/{workflows,data-model}.md`, `packages/core/src/index.ts`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify            # 580 tests, exit 0
bash infra/scripts/failure-drill.sh <api>    # 5 passed, 0 failed
bash /tmp/live-reliability.sh                # health, stall detection, sweep
bash /tmp/drill3.sh                          # provider outage
```

## TEST RESULTS

580 passed. New coverage: health reporting healthy when idle, **degraded rather than unhealthy**
when dependencies are fine but work is stuck, detection of unprocessed captures, ungated drafts,
stale approvals, retrying publications, overdue slots and dead jobs, error summarization, sweep
requeueing within budget, dead-lettering past budget with a recorded reason, releasing abandoned
jobs, sweep idempotency across three runs, and due-publication listing.

**A genuine gotcha surfaced while writing these tests:** `set_updated_at` fires on every UPDATE, so
`updated_at` cannot be backdated by a normal statement - a test simulating an aged row must disable
the trigger deliberately. That is correct production behavior (the column always means "last
touched"), and it is now documented in `docs/data-model.md` so the next person does not lose an
hour to it.

## MANUAL VERIFICATION

```
$ curl .../health/system                      # idle
  status: healthy | checks: {database: True, migrations: True} | stalled: 0

$ bash infra/scripts/failure-drill.sh
  PASS  short capture returns 422
  PASS  unsigned webhook is rejected
  PASS  telegram update without a secret does not apply a decision
  PASS  second capture returns the original id
  PASS  unknown content item returns 404
  drill complete: 5 passed, 0 failed

$ # an item left waiting 100 hours
  status: degraded
  stalled: awaiting_approval x1 oldest=100h - waiting for a human decision

$ # LLM_PROVIDER=failing
  process with the model down: http 503, error: E_LLM_UNREACHABLE
  psql -> status=failed | classification null=true | atoms for it: 0
  health -> status: degraded | recent errors: [('E_LLM_UNREACHABLE', 1)]

$ # sweep twice
  {'released_jobs': 0, 'requeued_publications': 0, 'dead_letters': 0}
  {'released_jobs': 0, 'requeued_publications': 0, 'dead_letters': 0}
```

## SECURITY REVIEW

Audit performed this milestone:

| Check                                       | Result                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| credential-shaped literals in tracked files | none                                                                                                                               |
| `.env` files tracked                        | only `infra/.env.example`                                                                                                          |
| string-concatenated SQL                     | only test-schema DDL in `packages/db/src/testing.ts`, built from a sanitized suite name; all application queries are parameterized |
| `console.log` outside CLIs                  | none                                                                                                                               |
| external calls without a timeout            | none                                                                                                                               |
| webhook authentication                      | GitHub HMAC over raw bytes, Telegram secret token, both constant-time                                                              |
| live publishing guards                      | three independent (approved item, explicit mode, non-simulated provider)                                                           |

## KNOWN LIMITATIONS

1. **Restart drills need a Docker host.** Service, database and Redis restart tests are documented
   in `docs/runbook.md` and `docs/incident-runbook.md` but cannot run here (no Docker daemon).
   Data survival across restarts rests on named volumes and durable state, both asserted
   statically; the operator should run the drill once.
2. `backup-verify.sh` requires the compose stack, for the same reason. Its logic is straightforward
   (dump, restore to scratch, compare counts, drop scratch) and it refuses to touch the live
   database.
3. Stall thresholds are fixed constants chosen from how this pipeline behaves, not configuration.
   They are in one place (`STALL_THRESHOLDS_HOURS`) and easy to tune once real cadence data exists.
4. There is no external alerting: failures surface through `/health/system`, `error_events` and the
   weekly report. Routing them to Telegram continuously would need a notification-rate policy to
   avoid becoming noise.

## ACCEPTANCE CRITERIA

| Criterion                                   | Evidence                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failures are visible and diagnosable        | `/health/system` reports stalls with counts and ages; `/internal/errors` and `/internal/runs` trace by correlation id; provider outage drill showed the failure recorded and surfaced |
| Retries do not create duplicates            | claimed publication slot (Milestone 13 concurrency test), two unique keys on approvals, unique keys on captures, webhooks and analytics; sweep requeues without re-sending            |
| Secrets are handled safely                  | audit table above; tests assert API keys never reach error objects                                                                                                                    |
| State survives service restarts             | durable state in PostgreSQL, named volumes, no in-memory queues; the live restart drill remains an operator step (limitation 1)                                                       |
| Recovery procedure is documented and tested | `docs/incident-runbook.md`; sweep behavior covered by tests and run live, idempotent across repeats                                                                                   |

## RECOMMENDED NEXT MILESTONE

18 - End-to-end launch and final audit.
