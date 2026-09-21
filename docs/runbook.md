# Operations runbook

## First run

```bash
cp infra/.env.example infra/.env
# generate real local values
openssl rand -hex 32                     # N8N_ENCRYPTION_KEY
openssl rand -hex 24                     # POSTGRES_PASSWORD, N8N_BASIC_AUTH_PASSWORD
infra/scripts/start.sh                   # postgres, redis, n8n, ollama
pnpm install && pnpm db:migrate
infra/scripts/health.sh
```

Optional model pull (only when `LLM_PROVIDER=ollama`):

```bash
docker compose -f infra/docker-compose.yml exec ollama ollama pull llama3.1:8b
```

Application containers (after code exists):

```bash
infra/scripts/start.sh --with-app
```

## Daily commands

| Task                   | Command                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| start infrastructure   | `infra/scripts/start.sh`                                         |
| start everything       | `infra/scripts/start.sh --with-app`                              |
| stop (keep data)       | `infra/scripts/stop.sh`                                          |
| health of all services | `infra/scripts/health.sh`                                        |
| follow logs            | `infra/scripts/logs.sh [service]`                                |
| backup database        | `infra/scripts/backup.sh`                                        |
| restore database       | `infra/scripts/restore.sh infra/backups/sce-<ts>.sql.gz`         |
| destroy all local data | `infra/scripts/reset.sh --force` (asks for a typed confirmation) |

## Ports

All host ports bind to `127.0.0.1` only, so nothing is exposed to the network.

| Service  | Host port | Health check                                    |
| -------- | --------- | ----------------------------------------------- |
| postgres | 5432      | `pg_isready` every 10s                          |
| redis    | 6379      | `redis-cli ping` every 10s                      |
| n8n      | 5678      | `GET /healthz` every 15s                        |
| ollama   | 11434     | `ollama list` every 20s                         |
| api      | 8080      | `GET /health/live` every 15s (app profile only) |

## Persistence

Named volumes survive `stop.sh` and machine restarts:
`sce-postgres-data`, `sce-redis-data`, `sce-n8n-data`, `sce-ollama-models`.
Only `reset.sh --force` removes them, after taking a backup and requiring the operator to type
`DESTROY`.

## Restart drill (run after any compose change)

```bash
infra/scripts/start.sh
psql "$DATABASE_URL" -c "create table if not exists restart_probe(id int primary key); insert into restart_probe values (1) on conflict do nothing;"
infra/scripts/stop.sh && infra/scripts/start.sh
psql "$DATABASE_URL" -c "select count(*) from restart_probe;"   # expect 1
psql "$DATABASE_URL" -c "drop table restart_probe;"
```

n8n equivalent: create a workflow, restart, confirm it is still listed in the editor.

## Troubleshooting

| Symptom                                             | Likely cause                                                  | Action                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| compose exits complaining about `POSTGRES_PASSWORD` | `infra/.env` missing or incomplete                            | copy `.env.example` and fill it                                              |
| n8n restarts repeatedly                             | wrong `N8N_ENCRYPTION_KEY` for the existing volume            | restore the original key, or reset the n8n volume and re-import workflows    |
| `pnpm db:migrate` cannot connect                    | `DATABASE_URL` points at the container hostname from the host | use `localhost:5432` from the host, `postgres:5432` from inside compose      |
| ollama health check fails                           | model still downloading or insufficient memory                | `infra/scripts/logs.sh ollama`; keep `LLM_PROVIDER=mock` until it is healthy |
| api unhealthy at boot                               | invalid environment configuration (by design)                 | read the validation error in `infra/scripts/logs.sh api`                     |
