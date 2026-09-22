# Incident runbook

What to check, in order, when something looks wrong. Every step is read-only until the "act"
sections.

## 1. Is it up, or is it stuck?

```bash
curl -s localhost:8080/health/live     # process alive (touches nothing)
curl -s localhost:8080/health/ready    # dependencies usable
curl -s localhost:8080/health/system   # dependencies AND whether work is moving
```

`/health/system` returns:

| status      | meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `healthy`   | dependencies fine, nothing stalled                                              |
| `degraded`  | dependencies fine, but work is stuck somewhere (the `stalled` array says where) |
| `unhealthy` | a dependency is unusable                                                        |

**`degraded` is the interesting one.** A system where every dependency is green while content has
sat in `pending_approval` for a week is broken in the way that actually matters.

## 2. What is stuck, and why?

| `stalled.kind`         | Meaning                              | First action                                                         |
| ---------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `learning_unprocessed` | captured but never classified (>24h) | `POST /pipeline/process-pending`; check `LLM_PROVIDER` and the model |
| `draft_ungated`        | generated but never gated (>12h)     | `POST /content-items/:id/gate`                                       |
| `awaiting_approval`    | waiting on a human (>72h)            | it is waiting on you - approve, reject, or regenerate                |
| `publication_retrying` | retrying without succeeding (>6h)    | check the provider, then `POST /system/sweep`                        |
| `publication_overdue`  | slot passed, never confirmed (>2h)   | worker down? start it; the sweep confirms due slots                  |
| `job_dead`             | jobs that exhausted their retries    | read `last_error` in `jobs`, fix the cause, re-enqueue               |

Trace one item end to end by correlation id:

```bash
curl -s "localhost:8080/internal/runs?correlation_id=cor_..."
curl -s "localhost:8080/internal/errors?correlation_id=cor_..."
```

## 3. Common failures

| Symptom                                                     | Likely cause                                              | Fix                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Captures work, nothing classifies                           | Ollama down or model missing                              | `docker compose logs ollama`; `LLM_PROVIDER=mock` keeps the pipeline moving meanwhile   |
| Everything rejected by the gate with `SYNTHETIC_EVIDENCE`   | `RESEARCH_PROVIDER=mock` - by design                      | configure a real research provider, or use ideas that do not require evidence           |
| Telegram buttons do nothing                                 | webhook secret mismatch, or the webhook is not registered | `pnpm --filter @sce/bot bot set-webhook`; check `TELEGRAM_WEBHOOK_SECRET` on both sides |
| "That card is out of date"                                  | the content was regenerated after the card was sent       | request approval again for the current version                                          |
| Publication stuck `retry_pending`                           | provider erroring transiently                             | `POST /system/sweep`; after the attempt budget it becomes `failed` with the reason      |
| Publication `failed` with `E_PUBLISH_DUPLICATE_EXTERNAL_ID` | the provider returned an id already recorded              | investigate the provider; two rows must never claim one post                            |
| Weekly report missing                                       | worker not running, or `TELEGRAM_CHAT_ID` unset           | check the worker; generate manually with `POST /reports/weekly`                         |
| API refuses to start                                        | invalid configuration (deliberate)                        | read the validation error; it names the variable                                        |

## 4. Act: recover stuck work

```bash
curl -s -X POST localhost:8080/system/sweep
```

The sweep is idempotent and safe to run repeatedly. It:

- releases jobs abandoned by a crashed worker,
- returns retryable publications to `pending` (the claimed row means this can never double-post),
- dead-letters publications past their attempt budget, writing an `E_PUBLISH_EXHAUSTED` error row.

Confirming due publications happens in the same worker job (`system_sweep`, hourly).

## 5. Act: restore data

```bash
infra/scripts/backup.sh                        # take a dump
infra/scripts/backup-verify.sh                 # dump + restore into a scratch DB + compare counts
infra/scripts/restore.sh backups/sce-<ts>.sql.gz   # restore for real (asks for confirmation)
pnpm db:migrate                                # apply any newer migrations
```

`backup-verify.sh` exists because a backup nobody has restored is a hope, not a backup. It never
touches the live database - it restores into `<db>_restore_check` and drops it afterwards.

## 6. Act: stop everything safely

```bash
infra/scripts/stop.sh        # stops containers, keeps all data
```

Nothing publishes while the stack is down: publication state is durable, and the guards
(approved-only, dry-run default, claimed slot) hold across restarts.

## 7. Drills

Run these after any change to the failure paths:

```bash
infra/scripts/failure-drill.sh http://localhost:8080   # malformed input, unsigned webhooks, duplicates
infra/scripts/backup-verify.sh                          # backup + restore + row-count comparison
pnpm vitest run packages/core/src/health                # stall detection and sweep behavior
```

Provider-outage drills are configuration, not code: `LLM_PROVIDER=failing`,
`RESEARCH_PROVIDER=failing`, `PUBLISHING_PROVIDER=failing`, `TELEGRAM_PROVIDER=failing` each make
the corresponding stage fail so the recorded failure path can be observed end to end.

## 8. What never happens, even during an incident

- Nothing publishes without an `APPROVED` content item.
- Nothing publishes while `PUBLISH_MODE` is anything other than `live`.
- A retry never creates a second post: the slot is claimed behind a unique key before the provider
  is called.
- A failed research or generation step is never recorded as success.
- Unknown analytics stay unknown; they are never backfilled with zeroes.
