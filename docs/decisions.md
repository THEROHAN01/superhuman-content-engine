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

## ADR-007 - A curated `fixture` research provider for demos and end-to-end tests

**Context.** The `mock` research provider is deliberately synthetic: its hosts are RFC 2606
reserved example domains and its results are marked `synthetic: true`, so the quality gate blocks
any draft whose only evidence comes from it. That is the correct guardrail, but it also means the
complete learning-to-analytics path cannot be demonstrated on a machine with no search engine -
the path always stops at the gate.
**Decision.** Add a third offline provider, `fixture`, serving a small hand-curated corpus of
canonical documentation and standards links. It makes no network calls, claims no external API
contract, stores `provider = 'fixture'` on every source it produces, and the environment validator
refuses it when `NODE_ENV=production`.
**Consequences.** `infra/scripts/demo.sh` and `tests/e2e/` can walk the whole path offline. Fixture
evidence is permanently identifiable in the database and can never silently become production
evidence. The corpus entries are curated references, not fetched search results; an operator who
wants to treat them as genuine evidence for a specific claim must confirm them first.

## ADR-008 - A stranded publication may be retried through the same claimed row

**Context.** The first end-to-end failure drill exposed a dead end. After a transient provider
outage a publication became `retry_pending`; the hourly sweep moved it back to `pending` "so the
next publish run picks it up" - but `schedulePublication` returned _any_ already-claimed row
without calling the provider, and nothing else ever did. The publication could never acquire an
external id, so it could never be published or measured.
**Decision.** A claimed row is still returned untouched once it has reached the provider (that is
what makes a replay safe), but a row with no external id, in `pending` or `retry_pending`, and
still inside its attempt budget is retried through the _same_ row and the _same_ idempotency key.
**Consequences.** Recovery from a provider outage needs no manual database surgery, and a second
post remains impossible: the provider sees the identical idempotency key. A row that has spent its
attempt budget is left for the sweep to dead-letter rather than retried forever.

## ADR-009 - `failed` is a recoverable state for a learning event

**Context.** The same drill showed that a note whose processing failed because the model was
unreachable was stranded permanently: `failed` had no outgoing transitions, so a retry could not
move the event forward even once the model was back.
**Decision.** `failed` is recoverable - processing may start again from `normalized`. An event that
already finished is still never reopened by a late failure report.
**Consequences.** A transient outage costs a retry rather than a lost note. Re-running cannot
duplicate anything: a learning event has at most one atom, enforced by
`content_atoms_learning_event_key`.
