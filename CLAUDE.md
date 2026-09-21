# Superhuman Content Engine — Project Instructions

Persistent instructions for every Claude session in this repository. Read this first; it is the
architecture, conventions, and workflow contract. The build plan PDF is the product spec
(`docs/build-plan.md` holds the extracted, authoritative text).

## 1. Mission

Convert Rohan's real learning and engineering work into structured knowledge, research-backed
content opportunities, platform-native drafts, human-approved scheduled posts, analytics, and
weekly intelligence — without ever publishing unverified or unapproved content.

Pipeline (provenance must survive every hop):

```
learning_event -> source_document(s) -> content_atom -> content_idea -> content_item(version)
  -> quality_gate_result -> approval -> publication -> analytics_event -> weekly_report
```

## 2. Non-negotiable rules

1. **Never commit secrets.** Only `.env.example` with placeholders. `.env` is git-ignored.
2. **Never publish real social content** from development. `PUBLISH_MODE=dry_run` is the default
   and the publishing adapter must refuse live mode unless `PUBLISH_MODE=live` *and* the content
   row is `APPROVED`.
3. **Never invent APIs, credentials, endpoints, or external behavior.** If an external contract is
   unverified, implement it behind an adapter interface, default to the `mock` provider, and
   record the assumption in `docs/external-apis.md`.
4. **Idempotency everywhere.** Any handler reachable twice (webhook, retry, Telegram callback,
   job, approval, publish) must key on a deterministic idempotency key and be safe to replay.
   Use `packages/utils` `idempotencyKey()` + the DB unique constraints; never "check then insert"
   without a unique index behind it.
5. **No silent failures.** Every catch either recovers deterministically or records an
   `error_events` row and re-throws/returns a typed failure. A failed research/generation step
   must never be recorded as a successful one.
6. **Verify, don't assert.** Never report something works without having run it. Tests, `curl`,
   `psql` output, or command logs are the evidence.
7. **Preserve provenance and history.** Regeneration creates a new `content_items` version; it
   never overwrites. Duplicate learning events keep a reference to the original rather than
   being deleted.
8. **Unknown is not zero.** Missing analytics metrics stay `NULL`, never `0`.

## 3. Stack and layout

- Runtime: **Node 22**, TypeScript (ESM, `NodeNext`), strict mode.
- Package manager: **pnpm** workspaces (`pnpm-workspace.yaml`). Never use npm/yarn here.
- HTTP: **Fastify 5** + **zod** validation at every boundary.
- DB: **PostgreSQL 16** via `pg`, with hand-written, forward-only SQL migrations run by
  `packages/db` (`pnpm db:migrate`). No ORM.
- Cache/locks/dedup: **Redis 7** via `ioredis`.
- Orchestration: **n8n** workflows (JSON exported into `n8n/workflows/`).
- LLM: **Ollama** (`/api/chat`) behind `packages/adapters/llm`, `mock` provider by default.
- Publishing: **Postiz** behind `packages/adapters/publishing`, `mock` provider by default.
- Approval: **Telegram Bot API** behind `packages/adapters/telegram`, `mock` by default.
- Tests: **vitest**. Logging: **pino** (redacted).

```
apps/api        Fastify HTTP API: capture, pipeline, webhooks, admin
apps/workers    scheduled/queued jobs (analytics, weekly report, retries)
apps/bot        Telegram approval bot (webhook handler + standalone dev poller)
packages/schemas  zod contracts + JSON Schema exports (versioned)
packages/db       migrations, pool, repositories
packages/prompts  brand voice, banned phrases, versioned prompt templates
packages/adapters llm / publishing / telegram / research / github
packages/utils    ids, hashing, retry, logger, errors, correlation, time
infra/          docker-compose.yml, .env.example, scripts/
n8n/workflows/  exported workflow JSON (no credential values)
docs/           architecture, runbooks, milestone reports
tests/          cross-package e2e
```

## 4. Conventions

- **Module names**: `@sce/<package>`. Imports between workspace packages use the package name.
- **Files**: kebab-case. Types/interfaces PascalCase. Constants SCREAMING_SNAKE.
- **Every exported function that crosses a boundary takes a typed input and returns a typed
  result**; no `any`, no untyped `object`.
- **IDs**: UUID v7-ish sortable ids from `@sce/utils` (`newId('le')` -> `le_01H...`). Prefixes:
  `le_` learning event, `sd_` source document, `ca_` content atom, `ci_` idea, `it_` content item,
  `qg_` quality gate, `ap_` approval, `pb_` publication, `ae_` analytics event, `wr_` weekly report,
  `run_` workflow run, `ev_` error event.
- **Status enums** live in `packages/schemas/src/enums.ts` and are mirrored by Postgres enum-like
  `TEXT ... CHECK` constraints. Change both, in one migration, or not at all.
- **Migrations**: `packages/db/migrations/NNNN_description.sql`, forward-only, idempotent
  (`IF NOT EXISTS`), never edited after being committed — add a new one instead.
- **Prompts**: versioned files `packages/prompts/src/<name>.v<N>.ts`; the version string is stored
  on every generated row. Never mutate a shipped prompt version; add `v<N+1>`.
- **Correlation**: every request/job carries `correlation_id`; pass it through to the DB and logs.

## 5. Workflow for every change

1. Read the relevant milestone in `docs/build-plan.md` and the acceptance criteria.
2. Inspect what already exists (`rg`, read the files) — never blind-overwrite working code.
3. Implement the smallest coherent slice.
4. Run `pnpm verify` (typecheck + lint + tests). DB-backed tests need `DATABASE_URL`.
5. Fix all failures. Never skip or weaken a test to make it pass.
6. Self-review the diff as a senior engineer (assumptions, validation, duplicate execution,
   races, secrets, error swallowing, observability, docs).
7. Update `docs/` (architecture, workflows, env vars, troubleshooting) and
   `docs/milestones/NN-*.md` with the completion report.
8. Commit with a descriptive message scoped to the milestone.

## 6. Commands

```bash
pnpm install              # install workspace deps
pnpm build                # tsc build all packages
pnpm typecheck            # tsc --noEmit
pnpm lint                 # prettier --check + eslint
pnpm test                 # vitest run (unit; DB tests skip without DATABASE_URL)
pnpm verify               # typecheck + lint + test  <- the gate before any commit
pnpm db:migrate           # apply migrations
pnpm db:seed              # insert example/fixture rows (safe, idempotent)
pnpm db:reset             # DROP and rebuild (destructive; refuses without --force)
pnpm dev:api              # run the API locally
infra/scripts/start.sh    # docker compose up (postgres, redis, n8n, ollama, api)
```

## 7. Environment

All variables are declared once in `packages/utils/src/env.ts` (zod-validated) and documented in
`docs/environment.md` + `infra/.env.example`. Adding a variable means touching all three. The API
refuses to boot on invalid config — that is intentional.

Development defaults: every external provider is `mock`, `PUBLISH_MODE=dry_run`,
`TELEGRAM_MODE=mock`. Only an explicit operator action flips those.

## 8. Testing policy

- Unit tests: pure functions, schemas, prompt rendering, adapters against fake transports.
- DB tests: real PostgreSQL, one schema per test file via `TEST_SCHEMA`, migrations applied,
  rolled back/dropped at the end. Skipped (not faked) when `DATABASE_URL` is absent.
- Contract tests: every external adapter has a `mock` implementation that the e2e path uses.
- Idempotency tests are mandatory for webhooks, approvals, publishing and jobs: run the operation
  twice, assert exactly one effect.
- Fixtures live in `tests/fixtures/` and are shared between unit and e2e tests.

## 9. Security

- Secrets only from env; never logged (pino `redact` covers `authorization`, `token`, `api_key`,
  `password`, `secret`).
- Webhooks verify signatures/shared secrets (`GitHub` HMAC-SHA256, Telegram secret token header,
  capture API bearer token) with constant-time comparison.
- All external HTTP calls: explicit timeout, bounded retries with jitter, no unbounded bodies.
- Rate limiting on public routes.
