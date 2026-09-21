# Milestone 02 - Docker and local infrastructure

**STATUS: COMPLETE** (with one environment-bound limitation, see below)

**OBJECTIVE:** Create a reproducible local runtime for the automation stack.

## WHAT I BUILT

`infra/docker-compose.yml` with PostgreSQL 16, Redis 7.4, n8n 2.40.5 and Ollama 0.34.2 on an
isolated bridge network, each with named volumes, health checks and loopback-only ports, plus the
application services behind an `app` profile; a multi-stage Dockerfile for the API/workers image;
`.env.example` covering every setting; seven operational scripts (start/stop/reset/backup/restore/
logs/health); environment and runbook documentation; CI that validates all of it.

## TASKS COMPLETED

| # | Atomic task | Result |
| --- | --- | --- |
| 1 | Choose supported images/versions | done - tags verified against Docker Hub's API, not guessed: `postgres:16.15-alpine`, `redis:7.4-alpine`, `n8nio/n8n:2.40.5`, `ollama/ollama:0.34.2` |
| 2 | Create `infra/docker-compose.yml` | done |
| 3 | Named persistent volumes | done - `sce-postgres-data`, `sce-redis-data`, `sce-n8n-data`, `sce-ollama-models` |
| 4 | Isolated network | done - `sce-net` bridge, every service attached |
| 5 | Health checks | done - all five long-running services |
| 6 | Expose only required ports | done - all published ports bound to `127.0.0.1` |
| 7 | `.env.example` with placeholders | done - 40 variables, grouped and commented |
| 8 | start script | done - `infra/scripts/start.sh` (`--with-app` for application services) |
| 9 | stop script | done - keeps volumes |
| 10 | reset script with destruction warning | done - requires `--force`, takes a backup, requires typing `DESTROY` |
| 11 | Consistent timezone | done - `TZ` propagated to all services, plus Postgres `timezone`/`log_timezone` and n8n `GENERIC_TIMEZONE` |
| 12 | PostgreSQL initialization | done - UTF8/C locale, tuned logging, `initdb` script creates the `n8n` and `sce_test` databases |
| 13 | n8n persistence | done - `/home/node/.n8n` volume, Postgres backend in a separate database, execution pruning at 14 days |
| 14 | Ollama persistence | done - `/root/.ollama` volume, `OLLAMA_MODELS` pinned |
| 15 | Document first-run commands | done - `docs/runbook.md` |
| 16 | Start the stack from clean state | **not possible in this environment** - no Docker daemon (`/var/run/docker.sock` absent). Configuration validated with `docker compose config` for both the default and `app` profiles |
| 17 | Verify service health individually | script written (`infra/scripts/health.sh`) and documented; execution requires a Docker host |
| 18 | Verify restart persistence | drill documented in `docs/runbook.md`; requires a Docker host |
| 19 | No cloud deployment | respected |

## FILES CREATED

`infra/docker-compose.yml`, `infra/api.Dockerfile`, `infra/.env.example`,
`infra/postgres/initdb/01-databases.sql`, `infra/scripts/{start,stop,reset,backup,restore,logs,health}.sh`,
`docs/environment.md`, `docs/runbook.md`, `tests/infra/compose.test.ts`, `.github/workflows/ci.yml`.

## FILES MODIFIED

`package.json` (added the `yaml` dev dependency used by the compose test), `pnpm-lock.yaml`,
`docs/environment.md` (added `OLLAMA_PORT` after a test flagged it as undocumented).

## TESTS RUN

```
docker compose --env-file .env.example config                 # default profile
docker compose --env-file .env.example --profile app config   # with api + workers
pnpm verify                                                   # typecheck + lint + 21 tests
```

## TEST RESULTS

- `docker compose config`: exit 0 for both profiles. Rendered services: postgres
  (`postgres:16.15-alpine`), redis (`redis:7.4-alpine`), n8n (`n8nio/n8n:2.40.5`), ollama
  (`ollama/ollama:0.34.2`), api + workers (built from `infra/api.Dockerfile`, profile `app`).
- `pnpm verify`: PASS - Test Files 2 passed (2), Tests 21 passed (21).
- The 15 new infrastructure tests assert: service set and profiles, pinned image tags (never
  `latest`), health check + restart policy on every service, loopback-only port bindings, named
  volumes for stateful services, single isolated network, mock/dry-run provider defaults, no
  literal secrets in compose, `.env.example` covers every compose variable, every variable is
  documented in `docs/environment.md`, `.env.example` holds placeholders only, scripts exist and
  are executable, `reset.sh` is guarded, `stop.sh` never removes volumes, scripts use strict bash.
- One test failure occurred and was fixed rather than suppressed: `OLLAMA_PORT` existed in
  `.env.example` but was missing from `docs/environment.md`.

## MANUAL VERIFICATION

```
$ docker compose --env-file .env.example config | head
name: sce
services:
  n8n: image: n8nio/n8n:2.40.5 ...
$ bash -n infra/scripts/*.sh      # all scripts parse
$ curl -s https://hub.docker.com/v2/repositories/library/postgres/tags | ...
  -> 16.15-alpine present (tags verified before pinning)
```

## SECURITY REVIEW

- No credential values in compose; every secret is a `${VAR}` reference, and `POSTGRES_PASSWORD`
  and `N8N_ENCRYPTION_KEY` use `${VAR:?...}` so the stack refuses to start unconfigured.
- All host ports bind to `127.0.0.1`; nothing is reachable from the network.
- n8n basic auth is enabled, telemetry/version notifications disabled.
- The runtime image runs as the non-root `node` user.
- `.env.example` contains only `change-me-*` placeholders, asserted by a test.
- CI has a dedicated secret-scanning job.

## KNOWN LIMITATIONS

1. **The stack was not started here** - the build environment has the Docker CLI but no daemon
   (risk R7). Acceptance criteria 1, 2 and 3 are verified by configuration and by scripts, not by
   a live run. The operator must run `infra/scripts/start.sh`, `infra/scripts/health.sh` and the
   restart drill in `docs/runbook.md` once on a Docker-capable host. CI's `compose` job builds the
   image and validates the configuration on every push.
2. Ollama runs CPU-only; no GPU passthrough is configured (deliberate for a laptop-first setup).
3. `backup.sh`/`restore.sh` cover PostgreSQL only; n8n workflows are version-controlled instead,
   and Ollama models are re-pullable.

## GIT DIFF SUMMARY

12 files added, 3 modified. No application behavior exists yet to change.

## ACCEPTANCE CRITERIA

| Criterion | Evidence |
| --- | --- |
| All core services start from documented commands | `infra/scripts/start.sh` + `docs/runbook.md`; configuration validated by `docker compose config` (both profiles). Live start-up pending a Docker host - see limitation 1 |
| Data survives a normal restart | named volumes for all four stateful services (asserted by test), `stop.sh` never passes a volume-removing flag (asserted by test), restart drill documented |
| Reset behavior is explicit and safe | `reset.sh` requires `--force`, prints exactly what is destroyed, takes a backup, and requires typing `DESTROY` (asserted by test) |
| No real credentials committed | compose test asserts every credential is an env reference; `.env.example` placeholders asserted; CI secret scan job |
| Health checks and ports documented | `docs/runbook.md` ports/health table; health checks asserted by test |

## RECOMMENDED NEXT MILESTONE

03 - Database and shared schemas.
