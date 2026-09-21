# n8n workflows

n8n is the **orchestration layer only**. Business logic lives in `apps/api` behind versioned HTTP
endpoints that have tests; workflows wire triggers, scheduling, retries and error routing to those
endpoints. A workflow must never contain business rules, secrets, or direct database writes.

## Conventions

| Thing                  | Convention                             | Example                |
| ---------------------- | -------------------------------------- | ---------------------- |
| Workflow name and file | `domain_action_v<N>`                   | `learning_capture_v1`  |
| Webhook path           | `sce/<domain>/<action>`                | `sce/learning/capture` |
| Credential name        | `sce_<service>_<env>`                  | `sce_postgres_local`   |
| Environment            | `SCE_API_BASE_URL` injected by compose | `http://api:8080`      |

Every workflow:

1. normalizes its input and ensures `correlation_id` exists (generating one when absent);
2. sets an explicit timeout and bounded retries on each HTTP node;
3. routes failures to `system_error_handler_v1` instead of swallowing them;
4. calls endpoints that are idempotent, so a retry cannot double-write.

## Import / export

```bash
infra/scripts/n8n-export.sh     # running n8n -> n8n/workflows/*.json (credentials stripped)
infra/scripts/n8n-import.sh     # n8n/workflows/*.json -> running n8n
```

Exports are sanitized: credential values, instance ids, execution ids and volatile timestamps are
removed so the JSON diffs cleanly in review. A Claude hook additionally refuses to write workflow
files containing credential values.

## Credentials

Credential **values never leave n8n**. `n8n/credentials/*.example.json` documents the shape and
the environment variable each field should be filled from; the operator creates the real
credentials once, in the n8n UI, and `N8N_ENCRYPTION_KEY` keeps them readable across restarts.

| Credential           | Type         | Fill from                    |
| -------------------- | ------------ | ---------------------------- |
| `sce_postgres_local` | Postgres     | `POSTGRES_*` in `infra/.env` |
| `sce_api_token`      | Header Auth  | `CAPTURE_API_TOKEN`          |
| `sce_telegram_bot`   | Telegram API | `TELEGRAM_BOT_TOKEN`         |

## Catalog

See `docs/workflows.md`.
