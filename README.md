# Superhuman Content Engine

Turns real learning and engineering work into structured knowledge, research-backed content
opportunities, platform-native drafts, human-approved scheduled posts, analytics and weekly
intelligence.

```
learning event -> sources -> content atom -> ideas -> drafts -> quality gate
   -> Telegram approval -> scheduled publication -> analytics -> weekly report
```

Nothing reaches a social platform without an explicit human approval, and nothing is sent at all
unless the publish mode is deliberately switched to live. Development defaults to mocked
providers and dry runs.

## Status

**v0.1.0 - first stable release.** All 18 milestones of `docs/build-plan.md` are complete and the
whole path from a captured note to a weekly report is covered by an end-to-end suite that runs
against a real database. Per-milestone reports: `docs/milestones/README.md`. What must be true
before this is pointed at a real account: `docs/launch-checklist.md`.

Every external provider still defaults to a mock, and `PUBLISH_MODE=dry_run` is the default, so a
fresh clone cannot post anything anywhere.

## Setup

Requirements: **Node 22**, **pnpm 10**, **PostgreSQL 16** (Redis, n8n and Ollama are only needed
for the full stack).

```bash
pnpm install
pnpm verify                        # typecheck + lint + 600+ tests
```

Database-backed tests are _skipped_ unless a test database is configured - they are never faked:

```bash
createdb sce_test                  # the name must end in _test
export TEST_DATABASE_URL=postgres://sce:sce@localhost:5432/sce_test
pnpm verify                        # now runs the DB and end-to-end suites too
```

Run the API against a development database:

```bash
export DATABASE_URL=postgres://sce:sce@localhost:5432/sce_dev
pnpm db:migrate
pnpm dev:api                       # http://localhost:8080
```

Full stack (requires a running Docker daemon):

```bash
cp infra/.env.example infra/.env   # fill placeholders; this file is never committed
infra/scripts/start.sh             # postgres, redis, n8n, ollama
infra/scripts/start.sh --with-app  # ...and api + workers
```

## See it work

```bash
RESEARCH_PROVIDER=fixture pnpm dev:api &
infra/scripts/demo.sh              # walks one note through the entire engine, then replays it
```

The demo prints the id produced at every hop, ends by showing that a replay changes nothing, and
publishes nothing: every publication is a dry run against the mock provider.

`RESEARCH_PROVIDER=fixture` matters. The default `mock` research provider returns deliberately
_synthetic_ sources, and the quality gate blocks any draft whose evidence is synthetic - correct
behaviour, but it stops the demo at the gate. The `fixture` provider serves a small curated corpus
of canonical references instead, and is refused outright when `NODE_ENV=production`.

Other operational scripts:

| Script                           | What it does                                         |
| -------------------------------- | ---------------------------------------------------- |
| `infra/scripts/demo.sh`          | end-to-end demonstration against a running API       |
| `infra/scripts/failure-drill.sh` | proves the system refuses bad input and bad callers  |
| `infra/scripts/health.sh`        | per-service health of the docker stack               |
| `infra/scripts/backup-verify.sh` | takes a backup and restores it into a scratch schema |
| `infra/scripts/n8n-export.sh`    | exports workflows without credential values          |

## Documentation

| Doc                        | Contents                                                              |
| -------------------------- | --------------------------------------------------------------------- |
| `CLAUDE.md`                | project rules, conventions and workflow for AI and human contributors |
| `docs/build-plan.md`       | the specification (source of truth)                                   |
| `docs/architecture.md`     | target architecture, state machines, idempotency and failure model    |
| `docs/reconnaissance.md`   | current-state audit at project start                                  |
| `docs/risk-register.md`    | risks and mitigations                                                 |
| `docs/decisions.md`        | architecture decision log                                             |
| `docs/file-plan.md`        | which files each milestone touches                                    |
| `docs/milestones/`         | per-milestone completion reports                                      |
| `docs/launch-checklist.md` | what to verify before pointing this at a real account                 |
| `docs/runbook.md`          | setup, operations and troubleshooting                                 |
| `docs/incident-runbook.md` | what to do when something is stuck, failing or noisy                  |
| `docs/environment.md`      | every environment variable and what it does                           |
| `docs/api.md`              | HTTP surface                                                          |
| `docs/workflows.md`        | n8n workflow catalog                                                  |
| `docs/external-apis.md`    | external contracts, and which of them are still assumptions           |

## Layout

```
apps/api        Fastify HTTP API (all stateful operations)
apps/workers    scheduled jobs (analytics, weekly report, retries)
apps/bot        Telegram approval transport
packages/core   pipeline services - the only place state transitions happen
packages/db     migrations, pool, repositories
packages/schemas  zod contracts, status enums, platform constraints
packages/prompts  versioned prompts, brand voice, banned phrases
packages/adapters LLM / publishing / telegram / research / github (mock-first)
packages/utils    env, ids, hashing, retry, logger, errors
infra/          docker compose, env example, operational scripts
n8n/            exported workflows (no credential values)
docs/           architecture, runbooks, milestone reports
tests/e2e       the full learning-event-to-weekly-report acceptance suite
tests/infra     compose and workflow JSON checks
tests/fixtures  shared fixtures
```

## License

Private project. Not for redistribution.
