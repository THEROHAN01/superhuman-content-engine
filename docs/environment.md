# Environment variables

Single source of truth: `packages/utils/src/env.ts` (zod-validated at boot) mirrored by
`infra/.env.example`. Adding a variable means touching both plus this table. The API refuses to
start on invalid configuration - that is deliberate.

## Runtime

| Variable    | Required | Default        | Purpose                                                          |
| ----------- | -------- | -------------- | ---------------------------------------------------------------- |
| `TZ`        | no       | `Asia/Kolkata` | timezone for containers, Postgres, n8n and weekly report windows |
| `NODE_ENV`  | no       | `development`  | `development` / `test` / `production`                            |
| `LOG_LEVEL` | no       | `info`         | pino level                                                       |

## PostgreSQL

| Variable            | Required      | Default | Purpose                                                    |
| ------------------- | ------------- | ------- | ---------------------------------------------------------- |
| `POSTGRES_USER`     | compose       | `sce`   | database role                                              |
| `POSTGRES_PASSWORD` | **yes**       | -       | compose refuses to start without it                        |
| `POSTGRES_DB`       | compose       | `sce`   | application database                                       |
| `POSTGRES_PORT`     | no            | `5432`  | host port, bound to `127.0.0.1`                            |
| `DATABASE_URL`      | **yes** (app) | -       | connection string used by the app and `pnpm db:migrate`    |
| `TEST_DATABASE_URL` | tests         | -       | DB-backed tests; must end in `_test` or they refuse to run |

## Redis

| Variable     | Required      | Default | Purpose                                            |
| ------------ | ------------- | ------- | -------------------------------------------------- |
| `REDIS_PORT` | no            | `6379`  | host port, bound to `127.0.0.1`                    |
| `REDIS_URL`  | **yes** (app) | -       | idempotency locks, rate limiting, job coordination |

## n8n

| Variable                                          | Required | Default                  | Purpose                                                                  |
| ------------------------------------------------- | -------- | ------------------------ | ------------------------------------------------------------------------ |
| `N8N_PORT` / `N8N_HOST`                           | no       | `5678` / `localhost`     | editor and webhook host                                                  |
| `N8N_WEBHOOK_URL`                                 | no       | `http://localhost:5678/` | base URL used in webhook registrations                                   |
| `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD` | **yes**  | -                        | editor login                                                             |
| `N8N_ENCRYPTION_KEY`                              | **yes**  | -                        | encrypts stored credentials; losing it means recreating every credential |
| `N8N_DB_NAME`                                     | no       | `n8n`                    | separate database on the same Postgres instance                          |
| `N8N_EXECUTION_MAX_AGE_HOURS`                     | no       | `336` (14 days)          | execution retention                                                      |

## Ollama

| Variable            | Required                   | Default                  | Purpose                           |
| ------------------- | -------------------------- | ------------------------ | --------------------------------- |
| `OLLAMA_PORT`       | no                         | `11434`                  | host port, bound to `127.0.0.1`   |
| `OLLAMA_BASE_URL`   | when `LLM_PROVIDER=ollama` | `http://localhost:11434` | LLM endpoint                      |
| `OLLAMA_MODEL`      | when `LLM_PROVIDER=ollama` | `llama3.1:8b`            | model tag; must be pulled first   |
| `OLLAMA_KEEP_ALIVE` | no                         | `10m`                    | how long the model stays resident |
| `OLLAMA_TIMEOUT_MS` | no                         | `120000`                 | per-request timeout               |

## API

| Variable                    | Required                 | Default     | Purpose                                              |
| --------------------------- | ------------------------ | ----------- | ---------------------------------------------------- |
| `API_PORT`                  | no                       | `8080`      | HTTP port                                            |
| `API_BIND`                  | no                       | `127.0.0.1` | bind address; `0.0.0.0` requires `CAPTURE_API_TOKEN` |
| `CAPTURE_API_TOKEN`         | when not localhost-bound | -           | bearer token for capture endpoints                   |
| `API_RATE_LIMIT_PER_MINUTE` | no                       | `120`       | per-IP rate limit                                    |

## Provider selection (all mock by default)

| Variable              | Values                                      | Default   | Purpose                                                  |
| --------------------- | ------------------------------------------- | --------- | -------------------------------------------------------- |
| `LLM_PROVIDER`        | `mock` / `ollama` / `failing`               | `mock`    | generation backend                                       |
| `RESEARCH_PROVIDER`   | `mock` / `searxng` / `disabled` / `failing` | `mock`    | evidence search                                          |
| `PUBLISHING_PROVIDER` | `mock` / `postiz` / `failing`               | `mock`    | scheduling backend                                       |
| `TELEGRAM_PROVIDER`   | `mock` / `telegram` / `failing`             | `mock`    | approval transport                                       |
| `PUBLISH_MODE`        | `dry_run` / `live`                          | `dry_run` | `live` actually sends posts; never set it in development |

`failing` providers exist so error paths can be exercised in tests and drills.

## Credentials (only needed when the matching provider is not `mock`)

| Variable                             | Used by            | Notes                                              |
| ------------------------------------ | ------------------ | -------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                 | telegram adapter   | from BotFather                                     |
| `TELEGRAM_CHAT_ID`                   | telegram adapter   | destination chat for approval cards                |
| `TELEGRAM_WEBHOOK_SECRET`            | API webhook route  | compared against `X-Telegram-Bot-Api-Secret-Token` |
| `POSTIZ_BASE_URL` / `POSTIZ_API_KEY` | publishing adapter | self-hosted or hosted Postiz instance              |
| `GITHUB_WEBHOOK_SECRET`              | API webhook route  | HMAC-SHA256 signature verification                 |
| `SEARXNG_BASE_URL`                   | research adapter   | SearxNG instance with the JSON API enabled         |

## Timeouts and limits

`OLLAMA_TIMEOUT_MS`, `TELEGRAM_TIMEOUT_MS`, `POSTIZ_TIMEOUT_MS`, `RESEARCH_TIMEOUT_MS`,
`RESEARCH_MAX_SOURCES`, `API_RATE_LIMIT_PER_MINUTE`. Every outbound call has a timeout; there are
no unbounded waits.

## Secrets policy

Secrets come from the environment only. `infra/.env` is git-ignored, `infra/.env.example` holds
placeholders, and three Claude hooks plus a test block secret-shaped literals from being written
or committed.
