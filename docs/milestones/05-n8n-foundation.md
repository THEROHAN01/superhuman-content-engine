# Milestone 05 - n8n orchestration foundation

**STATUS: COMPLETE** (with one environment-bound limitation)

**OBJECTIVE:** Make n8n a version-controlled and observable orchestration layer.

## WHAT I BUILT

Six workflows in version control, generated from a script so ids and layout stay stable; a shared
error workflow that funnels every n8n failure into the same `error_events` table the API writes
to; a scheduled health workflow; three connectivity smoke tests; export/import scripts that strip
credentials; the naming and credential conventions; and a 72-assertion test suite that enforces
those conventions on every commit.

## TASKS COMPLETED

| #   | Atomic task                               | Result                                                                                                                                 |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Verify n8n persistent storage             | `n8n-data` volume + Postgres backend configured in Milestone 02; a live restart check remains an operator step (no Docker daemon here) |
| 2   | Workflow naming convention                | `domain_action_v<N>`, asserted by test                                                                                                 |
| 3   | Webhook naming convention                 | `sce/<domain>/<action>`, asserted by test                                                                                              |
| 4   | Credential naming convention              | `sce_<service>_<env>`, documented in `n8n/README.md` with example shapes                                                               |
| 5   | Shared environment variable documentation | `SCE_API_BASE_URL` injected by compose; `docs/environment.md`                                                                          |
| 6   | Error-handling workflow                   | `system_error_handler_v1` -> `POST /internal/errors` -> `error_events`                                                                 |
| 7   | Execution retention                       | pruning on, 14 days, successes and failures saved                                                                                      |
| 8   | Test webhook workflow                     | `test_webhook_v1`                                                                                                                      |
| 9   | Database connectivity workflow            | `test_db_connectivity_v1`                                                                                                              |
| 10  | HTTP connectivity workflow                | `test_http_connectivity_v1`                                                                                                            |
| 11  | Export workflows into the repository      | `n8n/workflows/*.json` (6 files)                                                                                                       |
| 12  | Document import/export safely             | `infra/scripts/n8n-{export,import}.sh` + `n8n/README.md`; export strips credential values, ids and volatile fields                     |
| 13  | Document credentials to recreate manually | `n8n/README.md` table + `n8n/credentials/*.example.json`                                                                               |
| 14  | Workflow catalog                          | `docs/workflows.md`                                                                                                                    |
| 15  | Correlation ids on important inputs       | entry-point workflows generate or propagate `correlation_id`; asserted by test; `GET /internal/runs?correlation_id=` traces it         |
| 16  | Restart test                              | deferred to an operator run - see limitations                                                                                          |

## FILES CREATED

`n8n/workflows/{learning_capture_v1,system_error_handler_v1,system_health_check_v1,test_webhook_v1,test_db_connectivity_v1,test_http_connectivity_v1}.json`,
`n8n/README.md`, `n8n/credentials/{sce_postgres_local,sce_api_token,sce_telegram_bot}.example.json`,
`infra/scripts/{n8n-export.sh,n8n-import.sh,generate-workflows.py}`,
`apps/api/src/routes/internal.ts`, `apps/api/src/internal.test.ts`,
`tests/infra/workflows.test.ts`, `docs/workflows.md`.

## FILES MODIFIED

`apps/api/src/app.ts` (register internal routes), `docs/milestones/README.md`.

## TESTS RUN

```
pnpm vitest run tests/infra                        # 72 assertions over the workflow exports
TEST_DATABASE_URL=... pnpm vitest run apps/api     # 20 tests incl. 4 for /internal/*
TEST_DATABASE_URL=... pnpm verify
```

## TEST RESULTS

All green. The workflow suite asserts, per file: naming, inactive-on-import, no dangling
connections, every node reachable from a trigger, HTTP timeouts + bounded retries + wired error
branch, API reached only through `$env.SCE_API_BASE_URL`, credential references without values,
no credential-shaped literals, webhook path convention, and correlation-id threading.

**A test found a real gap:** `system_health_check_v1`'s "Report degraded" node had
`continueErrorOutput` with nothing wired to its error output, so a failure while reporting a
failure would have vanished. Two terminal nodes now make both outcomes visible in the execution
list.

## MANUAL VERIFICATION

```
$ python3 infra/scripts/generate-workflows.py
generated: learning_capture_v1, system_error_handler_v1, system_health_check_v1,
           test_db_connectivity_v1, test_http_connectivity_v1, test_webhook_v1

$ curl -X POST localhost:8099/internal/errors -d '{"workflow":"learning_capture_v1","message":"..."}'
{"id":"ev_...","correlation_id":"cor_..."}     # asserted end-to-end in internal.test.ts

$ curl 'localhost:8099/internal/runs?correlation_id=cor_trace_1'
{"runs":[{"workflow":"learning_capture_v1","status":"succeeded",...}],"count":1}
```

## SECURITY REVIEW

- No credential values in any workflow file: exports keep `{id, name}` references only, the export
  script blanks secret-shaped fields, a test greps for embedded secrets, and a Claude write hook
  refuses to save a workflow file containing them.
- Workflows ship inactive, so importing cannot silently start a webhook or a schedule.
- `/internal/*` endpoints sit behind the same bearer auth as capture.
- The error report endpoint validates its payload, so a malformed n8n failure cannot write junk
  into `error_events` (test asserts zero rows on a rejected report).

## KNOWN LIMITATIONS

1. **Not executed against a live n8n.** No Docker daemon exists in this environment, so "at least
   one test workflow executes successfully" and the restart-persistence check are verified by
   construction and by the conventions suite, not by a run. Operator steps: `infra/scripts/start.sh`,
   `infra/scripts/n8n-import.sh`, run `test_webhook_v1` and `test_db_connectivity_v1`, restart, and
   confirm the workflows are still listed.
2. The `executeWorkflow` node in `learning_capture_v1` references the error handler by name;
   n8n resolves workflow ids on import, so the operator should confirm the selection once.
3. Workflows are generated rather than hand-edited. Edits made in the UI must come back through
   `n8n-export.sh`, and the generator updated to match, or the next generation will overwrite them.

## ACCEPTANCE CRITERIA

| Criterion                                        | Evidence                                                                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| n8n survives restart                             | Postgres-backed n8n + `n8n-data` volume (Milestone 02 compose tests); live restart drill documented as an operator step                                                                |
| At least one test workflow executes successfully | three smoke workflows shipped and structurally validated; execution requires a Docker host (limitation 1)                                                                              |
| Workflow exports are stored in version control   | `n8n/workflows/*.json`, 6 files, regenerable and test-validated                                                                                                                        |
| Credential values are not stored in Git          | export scrubbing + convention tests + example-only credential files + write hook                                                                                                       |
| Error workflow is reachable from a test failure  | `system_error_handler_v1` posts to `/internal/errors`; the endpoint is covered end-to-end by `internal.test.ts`, and `learning_capture_v1` routes its HTTP error output to the handler |

## RECOMMENDED NEXT MILESTONE

06 - Learning normalization, classification and deduplication.
