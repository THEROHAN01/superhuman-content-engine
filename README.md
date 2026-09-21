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

Under construction against `docs/build-plan.md` (18 milestones).
Progress: `docs/milestones/README.md`.

## Quick start (no Docker needed for tests)

```bash
pnpm install
pnpm verify          # typecheck + lint + tests
```

Database-backed tests additionally need a PostgreSQL 16 instance:

```bash
export DATABASE_URL=postgres://sce:sce@localhost:5432/sce_dev
pnpm db:migrate
pnpm test
```

Full stack (requires a running Docker daemon):

```bash
cp infra/.env.example infra/.env   # fill placeholders; this file is never committed
infra/scripts/start.sh             # postgres, redis, n8n, ollama, api
```

## Documentation

| Doc                      | Contents                                                              |
| ------------------------ | --------------------------------------------------------------------- |
| `CLAUDE.md`              | project rules, conventions and workflow for AI and human contributors |
| `docs/build-plan.md`     | the specification (source of truth)                                   |
| `docs/architecture.md`   | target architecture, state machines, idempotency and failure model    |
| `docs/reconnaissance.md` | current-state audit at project start                                  |
| `docs/risk-register.md`  | risks and mitigations                                                 |
| `docs/decisions.md`      | architecture decision log                                             |
| `docs/file-plan.md`      | which files each milestone touches                                    |
| `docs/milestones/`       | per-milestone completion reports                                      |

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
docs/ tests/
```

## License

Private project. Not for redistribution.
