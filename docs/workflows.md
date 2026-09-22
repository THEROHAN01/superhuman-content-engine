# Workflow catalog

n8n orchestrates; the API owns the logic (ADR-002). Every workflow below is version-controlled in
`n8n/workflows/` and validated by `tests/infra/workflows.test.ts`.

| Workflow                    | Trigger                                                  | Inputs                                                                    | Calls                                           | Outputs                                                 | Failure path                                              | Credentials                                  |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| `learning_capture_v1`       | Webhook `POST sce/learning/capture`                      | `{text, title?, source?, external_id?, tags?, context?, correlation_id?}` | `POST /capture`                                 | capture confirmation JSON (`201` new / `200` duplicate) | HTTP error output -> `system_error_handler_v1`            | `sce_api_token` (when the API requires auth) |
| `system_error_handler_v1`   | Error trigger (set as `errorWorkflow` on every workflow) | n8n execution error object                                                | `POST /internal/errors`                         | `error_events` row                                      | terminal "Reporting failed" branch, visible in executions | `sce_api_token`                              |
| `system_health_check_v1`    | Schedule, every 15 minutes                               | -                                                                         | `GET /health/ready`                             | healthy, or an `E_HEALTH_DEGRADED` error event          | unreachable API also reports degraded                     | `sce_api_token`                              |
| `analytics_collect_v1`      | Schedule, daily 09:00                                    | -                                                                         | `POST /analytics/collect`                       | one analytics row per measurable publication and window | HTTP error output -> `POST /internal/errors`              | `sce_api_token`                              |
| `weekly_report_v1`          | Schedule, Mondays 08:00                                  | -                                                                         | `POST /reports/weekly`                          | the week's report, refreshed in place if it exists      | HTTP error output -> `POST /internal/errors`              | `sce_api_token`                              |
| `system_sweep_v1`           | Schedule, hourly                                         | -                                                                         | `POST /system/sweep`                            | released jobs, requeued and dead-lettered publications  | HTTP error output -> `POST /internal/errors`              | `sce_api_token`                              |
| `test_webhook_v1`           | Webhook `POST sce/test/echo`                             | anything                                                                  | -                                               | echoes the body with a correlation id                   | n/a (smoke test)                                          | none                                         |
| `test_db_connectivity_v1`   | Manual                                                   | -                                                                         | Postgres `SELECT count(*) FROM learning_events` | row count + timestamp                                   | error output -> "Connection failed"                       | `sce_postgres_local`                         |
| `test_http_connectivity_v1` | Manual                                                   | -                                                                         | `GET /health/live`                              | liveness JSON                                           | error output -> "API unreachable"                         | none                                         |

## Conventions enforced by tests

- Names and filenames match `domain_action_v<N>`; webhook paths match `sce/<domain>/<action>`.
- Workflows are exported **inactive**, so importing never starts something unattended.
- Every HTTP node has a timeout, 2-5 retries, and `onError: continueErrorOutput` with the error
  output actually wired to a node.
- Every node is reachable from a trigger; no dangling connections.
- The API is reached only via `$env.SCE_API_BASE_URL` (injected by compose) - no hardcoded hosts.
- Credentials appear as `{id, name}` references only; a test greps the JSON for embedded secrets.
- Entry-point workflows establish a `correlation_id` (from the caller, or `cor_n8n_<execution>`).

## Regenerating

The workflows are generated from `infra/scripts/generate-workflows.py`, so ids and layout stay
stable and diffs stay readable:

```bash
python3 infra/scripts/generate-workflows.py
pnpm vitest run tests/infra
```

Workflows edited in the n8n UI are brought back with `infra/scripts/n8n-export.sh` (which strips
credentials and volatile fields); `infra/scripts/n8n-import.sh` pushes them into a fresh n8n.

## Manual steps after importing

1. Create credentials in the n8n UI: `sce_postgres_local`, `sce_api_token`, `sce_telegram_bot`.
   Values come from `infra/.env`; they are never stored in Git.
2. Open each workflow and confirm its credential selection.
3. Set `system_error_handler_v1` as the error workflow (workflow settings) for any workflow you
   create by hand - the exported ones already carry it.
4. Activate only the workflows you want running.

## What runs where

n8n owns _when_; the API owns _what_. Every scheduled workflow above is a single HTTP call to an
endpoint that is idempotent on its own, so an overlapping or replayed execution cannot double
anything: analytics collection keys on `(publication, window, day)`, the weekly report on
`(period_key, generator_version)`, and the sweep only moves rows between states it owns.

The same jobs also exist inside `apps/workers` (`collect_analytics`, `weekly_report`,
`system_sweep`), so the system is operable without n8n at all - useful in development and as a
fallback if n8n is down. Running both is safe for exactly the reason above, but pick one as the
scheduler in production so execution history stays in one place.

Pipeline stages that n8n does _not_ schedule - processing, research, ideation, generation, gating,
approval - are driven by the API's own endpoints, because each one needs a human decision or a
prior stage's output. Every stage records a `workflow_runs` row (`learning_capture_v1`,
`learning_process_v1`, `atom_research_v1`, `atom_build_v1`, `content_ideate_v1`,
`content_generate_v1`, `content_quality_gate_v1`, `approval_request_v1`, `approval_decide_v1`,
`content_publish_v1`, `analytics_collect_v1`, `weekly_report_v1`, `system_sweep_v1`), so the
pipeline's history is in the database whether or not n8n was involved.

## Execution retention

`EXECUTIONS_DATA_MAX_AGE` (default 336 hours = 14 days) with pruning enabled, saving both
successful and failed executions. Long enough to debug last week's pipeline, short enough that the
volume does not grow without bound.
