# Architecture decision log

Short ADRs. Add one whenever a choice is non-obvious or departs from the build plan.

## ADR-001 - TypeScript monorepo with pnpm workspaces

**Context.** The repository was empty; the build plan prescribes `apps/`, `packages/`, `infra/`,
`n8n/`, `docs/`, `tests/`.
**Decision.** TypeScript (ESM, strict) on Node 22 with pnpm workspaces, adding `packages/db` and
`packages/core` to the plan's layout.
**Consequences.** One type system spans HTTP payloads, database rows, LLM output and n8n
contracts. `packages/core` keeps state transitions out of transports so they stay unit-testable.

## ADR-002 - Business logic in the API, orchestration in n8n

**Context.** The plan makes n8n the orchestrator.
**Decision.** n8n workflows call versioned HTTP endpoints; they hold no business logic, no secrets
and no direct database writes.
**Consequences.** Logic is testable and reviewable in Git and workflow JSON stays small, at the
cost of one HTTP hop per step - irrelevant at this volume.

## ADR-003 - Hand-written SQL migrations instead of an ORM

**Context.** Constraints and indexes are the main defence against duplicate publication, and
psql/n8n read the same schema.
**Decision.** Forward-only numbered SQL files applied by a small runner in `packages/db`, with
repositories written against `pg`.
**Consequences.** Constraints are explicit and reviewable; no hidden migration generation. Costs
some repository boilerplate.

## ADR-004 - Mock-first external adapters

**Context.** No Postiz/Telegram/search credentials exist in development, and the plan forbids
inventing external behavior.
**Decision.** Every adapter ships `mock`, `failing` and a real provider; `mock` is the default and
real providers are documented in `docs/external-apis.md` as verified or assumed.
**Consequences.** The pipeline is runnable and testable offline; going live is a configuration
change plus a documented verification step.

## ADR-005 - Dry-run publishing by default

**Context.** The plan forbids publishing real content during development.
**Decision.** Dry-run is the default publish mode; the publish service refuses live mode unless
the item is `APPROVED`; a Claude bash hook blocks commands that switch the mode to live.
**Consequences.** Accidental publication requires defeating three independent guards.

## ADR-006 - Local PostgreSQL and Redis for tests, Docker for the full stack

**Context.** The build environment has PostgreSQL 16 and Redis 7 installed but no Docker daemon.
**Decision.** Database-backed tests run against a real local PostgreSQL via `DATABASE_URL` and are
skipped (never faked) when it is absent. Compose files are validated statically here and started
by the operator on a Docker-capable host.
**Consequences.** Real constraint and idempotency verification is possible in CI and locally;
compose start-up is verified separately and recorded honestly as such.
