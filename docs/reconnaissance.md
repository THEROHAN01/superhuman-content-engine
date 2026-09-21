# Milestone 01 — Repository reconnaissance (current state)

Date: 2026-09-21. Performed against commit `0e1ec74` on branch
`claude/project-setup-implementation-h1f9xo`.

## 1. Inventory

The repository was **empty**: a bare Git checkout with no commits, no source files, no
configuration, no CI, no Docker assets, no documentation.

```
$ git log --oneline
fatal: your current branch '...' does not have any commits yet
$ ls -a
.  ..  .git
```

Consequence: there is **no existing work to preserve** and no risk of overwriting a better
implementation. Every convention in `CLAUDE.md` is therefore newly chosen rather than inherited,
and the target architecture in the build plan can be adopted directly.

### What exists after the control-layer commit

| Path                 | Purpose                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `CLAUDE.md`          | persistent project instructions (rules, stack, conventions, workflow)                     |
| `.claude/skills/`    | milestone, milestone-review, db-migration, n8n-workflow, external-adapter, prompt-version |
| `.claude/hooks/`     | write guard, bash guard, staged-secret check, formatter, session bootstrap                |
| `.claude/agents/`    | milestone-reviewer, idempotency-auditor, security-auditor, pipeline-explorer              |
| `.claude/commands/`  | `/verify`, `/milestone-report`                                                            |
| `docs/build-plan.md` | the specification PDF extracted verbatim (source of truth)                                |

## 2. Language, package manager, runtime, build system

Nothing was pre-existing, so these were chosen and are now fixed by `CLAUDE.md`:

| Concern         | Decision                                                   | Why                                                                            |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Language        | TypeScript 5.7, ESM, `strict` + `noUncheckedIndexedAccess` | shared types across API, workers, n8n payloads                                 |
| Runtime         | Node 22 (`>=22`)                                           | matches the container (`v22.22.2`), native `fetch`, `AbortSignal.timeout`      |
| Package manager | pnpm 10 workspaces                                         | build plan's monorepo layout; strict node_modules prevents phantom deps        |
| HTTP            | Fastify 5                                                  | schema-first, fast, first-class hooks for correlation ids and rate limiting    |
| Validation      | zod 3                                                      | one schema source for HTTP, DB payloads, LLM output and JSON Schema export     |
| DB access       | `pg` + hand-written SQL migrations                         | migrations are the contract n8n also depends on; an ORM would hide constraints |
| Tests           | vitest 3                                                   | ESM-native, fast, workspace aliases                                            |
| Build           | tsup (esbuild)                                             | bundles workspace packages so runtime needs no path-alias loader               |
| Lint/format     | eslint 9 (flat) + prettier 3                               | enforced by `pnpm verify` and the format hook                                  |

## 3. Environment observed on the development host

| Capability                                         | State                                                             | Impact                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 22.22.2, pnpm 10.33.0                         | available                                                         | primary toolchain                                                                                                                                  |
| PostgreSQL 16.13 server (`/usr/lib/postgresql/16`) | installed, started locally                                        | DB-backed tests run for real without Docker                                                                                                        |
| Redis 7.0.15 (`redis-server`)                      | installed                                                         | idempotency locks/rate limiting testable locally                                                                                                   |
| Docker CLI 29.3.1 + Compose v5.1.1                 | installed, **daemon not running** (`/var/run/docker.sock` absent) | compose files can only be validated statically (`docker compose config`); stack start-up must be verified by the operator on a Docker-capable host |
| n8n, Ollama, Postiz, Telegram, Notion              | not present, no credentials                                       | all integrations must be mock-first and credential-gated                                                                                           |

## 4. Existing integrations, TODOs, content pipeline code

None. Searches for Notion/Telegram/social/AI/queue integrations, `TODO`/`FIXME` markers, content
schemas and prompt files returned nothing because the tree was empty.

## 5. External dependencies and credential requirements

| Dependency       | Needed for                                       | Credentials                                                                      | Dev default                                        |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| PostgreSQL       | all durable state                                | connection URL (local, non-secret in dev)                                        | local server / compose                             |
| Redis            | idempotency locks, rate limits, job coordination | none locally                                                                     | local server / compose                             |
| n8n              | orchestration                                    | basic-auth user/password; per-service credentials created **manually in the UI** | compose                                            |
| Ollama           | LLM generation                                   | none (local HTTP)                                                                | `LLM_PROVIDER=mock`                                |
| Telegram Bot API | approval loop                                    | bot token, chat id, webhook secret                                               | `TELEGRAM_PROVIDER=mock`                           |
| Postiz           | scheduling/publishing                            | API key + base URL                                                               | `PUBLISHING_PROVIDER=mock`, `PUBLISH_MODE=dry_run` |
| GitHub           | engineering-event opportunities                  | webhook HMAC secret (+ optional PAT)                                             | signature-verified webhook, no PAT needed          |
| Research/search  | evidence enrichment                              | depends on provider (SearxNG instance URL)                                       | `RESEARCH_PROVIDER=mock`                           |
| Notion           | optional capture source                          | integration token, database id                                                   | not enabled; Telegram/HTTP capture first           |

## 6. What can be reused

Nothing from the repository. Reused from the environment: the local PostgreSQL 16 and Redis 7
services (for real, non-mocked tests) and the extracted build plan as the specification.

## 7. Constraints discovered

1. **No Docker daemon here.** `infra/docker-compose.yml` is written to spec and validated with
   `docker compose config`, but "stack starts from a clean state" (Milestone 02 acceptance) can
   only be demonstrated on a host with a running daemon. This is recorded as a known limitation
   rather than claimed as verified.
2. **No third-party credentials.** Every provider adapter therefore ships a deterministic `mock`
   implementation plus a `failing` implementation for error-path tests, and the real
   implementations are documented as _assumed until verified_ in `docs/external-apis.md`.
3. **No real publishing.** `PUBLISH_MODE=dry_run` is the default everywhere and a bash hook blocks
   commands that set it to `live`.
