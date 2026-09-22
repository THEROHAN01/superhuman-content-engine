# Target architecture

## 1. Data flow

```
        capture (HTTP / Telegram / Notion / GitHub event)
                 |
                 v
        learning_events  -- raw text preserved, content_hash computed
                 |  normalize . classify . dedupe
                 v
        content_atoms  <------ source_documents (research evidence)
                 |  ideate
                 v
        content_ideas
                 |  generate (per platform, versioned prompts)
                 v
        content_items (v1..vN)
                 |  quality gate (PASS / NEEDS_REVIEW / REJECT + reasons)
                 v
        approvals  (Telegram: approve / reject / regenerate / request-change)
                 |  only APPROVED continues
                 v
        publications (publishing adapter, idempotency key, external id)
                 |
                 v
        analytics_events (normalized metrics, unknown stays NULL)
                 |
                 v
        weekly_reports  ---> next-week content and learning suggestions
```

Every row carries the id of its parent, so any artifact resolves back to the learning event that
produced it. `workflow_runs` and `error_events` record execution and failure across all stages,
keyed by `correlation_id`.

## 2. Components

| Component            | Responsibility                                                                                                                                               | Not responsible for                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `apps/api` (Fastify) | every stateful operation: capture, normalize, atom build, ideation, generation, quality gate, approval callbacks, publish, analytics ingest, reports, health | scheduling, retries across time               |
| `apps/workers`       | time-based work: analytics collection, weekly report, retry of dead-lettered jobs, stale-state sweeps                                                        | business rules (delegates to `@sce/core`)     |
| `apps/bot`           | Telegram transport: webhook verification, dev long-poller, approval card rendering                                                                           | approval semantics (delegates to `@sce/core`) |
| `n8n`                | orchestration and scheduling of API endpoints; the visible operational surface                                                                               | business logic, secrets, direct DB writes     |
| `packages/core`      | pipeline services - the only place state transitions are decided                                                                                             | HTTP/transport concerns                       |
| `packages/db`        | pool, migrations, repositories, transactions                                                                                                                 | business rules                                |
| `packages/schemas`   | zod contracts for every payload, status enums, platform constraints                                                                                          | I/O                                           |
| `packages/adapters`  | LLM, publishing, telegram, research, github clients (mock / real / failing)                                                                                  | state transitions                             |
| `packages/prompts`   | versioned prompt templates, brand voice, banned phrases                                                                                                      | model invocation                              |
| `packages/utils`     | env, ids, hashing, retry, logger, errors, time, correlation                                                                                                  | domain knowledge                              |

**Why logic lives in the API and not in n8n:** code inside n8n Function nodes cannot be
unit-tested, reviewed as a diff, or replayed deterministically. n8n calls versioned HTTP endpoints
that tests cover; workflow JSON stays thin and reviewable.

## 3. State machines

```
learning_event:  RECEIVED -> NORMALIZED -> CLASSIFIED -> ATOMIZED
                       \-> DUPLICATE (keeps a reference to the original)
                       \-> FAILED (error_events row, retryable flag)

content_item:    DRAFT -> GATED -> PENDING_APPROVAL -> APPROVED -> SCHEDULED -> PUBLISHED
                             \-> REJECTED
                             \-> SUPERSEDED (regeneration creates a new version)
                             \-> FAILED

publication:     PENDING -> SCHEDULED -> PUBLISHED
                       \-> FAILED (permanent) | RETRY_PENDING (transient)
```

Transitions are monotonic: a replayed event can never move an item backwards, and only `APPROVED`
items may be scheduled.

## 4. Idempotency model

| Entry point                        | Deterministic key                                           | Database guarantee                             |
| ---------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| capture (HTTP / Telegram / Notion) | `sha256(source + external_id)` or `sha256(normalized text)` | unique index on `learning_events.content_hash` |
| GitHub webhook                     | delivery id + event id                                      | unique `webhook_deliveries.delivery_id`        |
| Telegram callback                  | callback query id + action id                               | unique `approvals.action_id`                   |
| generation                         | `(idea_id, platform, prompt_version, attempt)`              | unique index on `content_items`                |
| publish                            | `sha256(content_item_id + platform + scheduled_at)`         | unique `publications.idempotency_key`          |
| analytics collection               | `(publication_id, metric_window, collected_for)`            | unique index on `analytics_events`             |
| background jobs                    | `(job_type, dedupe_key)`                                    | unique `jobs.dedupe_key` while pending         |

Replays return the original result (same id, same status) rather than an error, so a retrying
caller converges instead of looping.

One deliberate exception: a publication that was claimed but never reached the provider - no
external id, `pending` or `retry_pending`, still inside its attempt budget - is retried through the
same row and the same idempotency key rather than returned untouched. Otherwise a provider outage
would strand it forever, because nothing else ever calls the provider for an already-claimed slot.
The provider still sees one idempotency key, so a second post remains impossible.

The whole model is exercised end to end by `tests/e2e/duplicate-path.test.ts`, which runs the
complete documented path twice and asserts the database is unchanged by the second pass.

## 5. Failure model

- Adapters return `{ok:true,...} | {ok:false, kind:'transient'|'permanent', ...}`. Transient
  failures retry with bounded exponential backoff and jitter; permanent failures stop immediately.
- Exhausted retries write an `error_events` row and move the owning entity to a dead-letter status
  that the health endpoint and the weekly report surface.
- A failed research or generation step is never recorded as a success: evidence status stays
  `unsupported` / `needs_review` (or `research_failed`, which is explicitly _not_ "found nothing"),
  and the quality gate treats missing evidence as a blocker.
- Failure states are recoverable, not terminal. A learning event that failed because the model was
  unreachable can be processed again once it is back; a publication stranded by a provider outage
  is retried through its existing row. Recovery never erases the incident: the `error_events` row
  stays, and the health endpoint keeps reporting it.
- `tests/e2e/failure-recovery.test.ts` takes each external dependency away in turn and asserts both
  halves: the failure is visible, and the system recovers without duplicating anything.

## 6. Security boundaries

Inbound: bearer token on the capture API, HMAC-SHA256 on GitHub webhooks, secret-token header on
Telegram webhooks, zod validation, body size limits and rate limits on every public route.
Outbound: explicit timeouts, bounded retries, no credentials in URLs or logs (pino redaction).
Publishing: live sends are impossible unless the publish mode is explicitly live and the item is
`APPROVED`.

## 7. Deployment shape (local first)

`infra/docker-compose.yml` runs postgres, redis, n8n, ollama and the API on an isolated network
with named volumes and health checks. Cloud deployment stays out of scope until the reliability
milestone is complete.
