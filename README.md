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

## Quick start

Requirements: **Node 22**, **pnpm 10**, **PostgreSQL 16**. (Redis, n8n and Ollama are only needed
for the full Docker stack; none of them are needed to run the engine or its tests.)

```bash
git clone <this repo> && cd superhuman-content-engine
pnpm install

createdb sce_dev
export DATABASE_URL=postgres://sce:sce@localhost:5432/sce_dev
pnpm db:migrate                                    # forward-only SQL, safe to re-run

RESEARCH_PROVIDER=fixture pnpm dev:api &           # http://localhost:8080
infra/scripts/demo.sh                              # the whole engine, one note, ~20 seconds
```

`demo.sh` walks a note from capture to weekly report, prints the id produced at every hop, and
finishes by replaying the path to show that nothing happens twice. It publishes nothing: every
provider is a mock and `PUBLISH_MODE` is `dry_run`.

To run the test suite the way CI does, add a test database - DB-backed tests are _skipped_ rather
than faked when it is missing, so a green run without one is not a full run:

```bash
createdb sce_test                                  # the name must end in _test
export TEST_DATABASE_URL=postgres://sce:sce@localhost:5432/sce_test
pnpm verify                                        # typecheck + lint + 629 tests
```

## Step by step: one note, end to end

The demo script automates exactly this. Do it by hand once and the system stops being a black box.
Every response below is real output from these commands, trimmed to the interesting fields. Ids,
timestamps and the mock provider's seeded metric numbers differ from run to run; nothing else
does.

Start the API with `DATABASE_URL` set and `RESEARCH_PROVIDER=fixture`, then:

**1. Capture what you learned.** No structure required - a paragraph is fine. Nothing else in the
pipeline can start without this, and nothing is lost if the rest of the system is down.

```bash
curl -X POST localhost:8080/capture -H 'content-type: application/json' -d '{
  "text": "Today I learned why refresh-token rotation matters. A long-lived static refresh token cannot be distinguished from a stolen one, because both present the same credential. With rotation each refresh issues a new token and invalidates its predecessor, so a replayed old token proves theft and lets the server revoke the whole family."
}'
```

```json
{ "id": "le_0mudit15c9...", "status": "received", "duplicate": false }
```

Send it twice and you get `"duplicate": true` with the same id - captures deduplicate on a hash of
the text, so a retrying client or a double tap cannot create two events. Set `LE` to that id for
the next step. Real intake usually comes from Telegram or n8n rather than curl; both call this
endpoint.

**2. Process it** - normalize, classify and deduplicate in one call.

```bash
curl -X POST "localhost:8080/learning-events/$LE/process"
```

```json
{
  "status": "atomized",
  "duplicate_of": null,
  "classification": {
    "kind": "core_engineering",
    "primary_topic": "security",
    "content_worthy": true
  },
  "content_atom_id": "ca_0mudit42u8..."
}
```

A note too similar to an earlier one stops here as `duplicate` with a reference to the original -
it is never deleted. To process everything captured while you were away, use
`POST /pipeline/process-pending` instead. Set `ATOM` to the `content_atom_id`.

**3. Find evidence.** Research is separate from processing because it depends on an external
service and must be retryable on its own.

```bash
curl -X POST "localhost:8080/content-atoms/$ATOM/research"
```

```
evidence_status supported, sources_added 3, synthetic_only false
  official_docs  https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication
  rfc            https://rfc-editor.org/rfc/rfc6749
  rfc            https://rfc-editor.org/rfc/rfc6819
```

If the provider is unreachable the atom becomes `research_failed` - explicitly _not_ "found
nothing" - and the call is safe to repeat once it is back.

**4. Build the atom**, the canonical structured form of what you learned: problem, core insight,
first principles, example, and a list of claims each carrying the source ids that support it.

```bash
curl -X POST "localhost:8080/content-atoms/$ATOM/build"
curl -s "localhost:8080/content-atoms/$ATOM" | jq   # the provenance view: atom + its sources
```

```json
{ "status": "ready", "evidence_status": "supported", "unsupported_claims": 0 }
```

A claim that no source supports keeps the atom out of `ready`; nothing downstream can run on it.

**5. Generate ideas** - the angles worth writing about. `queue` marks the best N for drafting.

```bash
curl -X POST "localhost:8080/content-atoms/$ATOM/ideas" -H 'content-type: application/json' \
     -d '{"queue": 2}'
```

```
created 2 | rejected 0
  ci_0muditdzd6... 0.75  insight       Why refresh-token rotation matters
  ci_0muditdzf1... 0.65  mental_model  A model for reasoning about security
```

Re-running is safe: an idea that repeats one already stored is rejected with a stated reason rather
than duplicated. Set `IDEA` to the one you want to draft.

**6. Write the drafts**, one per platform-native format.

```bash
curl -X POST "localhost:8080/content-ideas/$IDEA/generate" -H 'content-type: application/json' \
     -d '{"formats": ["x_post", "x_thread", "linkedin_post", "reel_script", "carousel"]}'
```

```
  x_post         it_0mudithzed7... v1  1 unit(s)  171 chars
  x_thread       it_0mudithzi31... v1  4 unit(s)  404 chars
  linkedin_post  it_0mudithzmdf... v1  1 unit(s)  392 chars
  reel_script    it_0mudithzp6d... v1  3 unit(s)  254 chars
  carousel       it_0mudithzsc4... v1  5 unit(s)  494 chars
```

Read one before you gate it - `curl -s localhost:8080/content-items/$ITEM | jq .draft` shows the
body, the units (tweets, slides, beats) and the source attributions carried down from the atom.
Set `ITEM` to the draft you want to publish.

**7. Run the quality gate.** A fixed list of deterministic checks - platform limits, banned
phrases, voice, evidence, repetition against what you have already posted. Every reason code is
listed in `docs/quality-gate.md`.

```bash
curl -X POST "localhost:8080/content-items/$ITEM/gate"
```

```json
{ "verdict": "pass", "score": 1, "status": "gated", "gate_version": "gate.v1", "reasons": [] }
```

`reasons` explains every deduction. A `warn` is advisory; a `block` (unsupported claim, synthetic
evidence, over the platform limit) rejects the draft and it cannot go to approval. Re-running
returns the stored verdict rather than re-judging.

**8. Ask for approval.** This sends the card - to Telegram for real, to an in-memory mock in
development.

```bash
curl -X POST "localhost:8080/content-items/$ITEM/request-approval" \
     -H 'content-type: application/json' -d '{"chat_id": "demo-chat"}'
```

```json
{ "status": "pending_approval", "message_id": "mock-msg-1" }
```

The card goes to `TELEGRAM_CHAT_ID` when that is set, so the body can be omitted once it is
configured. With the mock transport nothing leaves the process and any chat id will do.

**9. Decide.** In production you tap a button in Telegram and the webhook records it. The same
decision over HTTP, for the CLI, for tests, and for when the bot is down:

```bash
curl -X POST "localhost:8080/content-items/$ITEM/decide" -H 'content-type: application/json' \
     -d '{"action": "approve", "decided_by": "rohan"}'
```

```json
{ "status": "approved", "action": "approve", "applied": true, "regenerated_item_id": null }
```

`reject` (optionally with a `note`) and `regenerate` work the same way. Regeneration creates
version 2 and marks version 1 `superseded` - it never overwrites, so approval history keeps its
meaning. Deciding twice records one decision and reports `"applied": false` the second time.

**10. Schedule it.** This is the only step that talks to a publishing provider, and it refuses
anything that is not `approved`.

```bash
curl -X POST "localhost:8080/content-items/$ITEM/schedule" -H 'content-type: application/json' \
     -d '{"scheduled_at": "2026-09-24T09:00:00.000Z"}'
```

```json
{
  "publication_id": "pb_0mudittac4...",
  "status": "scheduled",
  "created": true,
  "dry_run": true,
  "provider": "mock",
  "external_id": "mock-post-1"
}
```

`dry_run: true` means nothing left the process. Scheduling the same item into the same slot again
returns this row untouched, with no second provider call. Set `PUB` to the `publication_id`.

**11. Confirm and measure.** The hourly worker sweep confirms slots whose time has passed; by hand
it is one call. Then collect metrics.

```bash
curl -X POST "localhost:8080/publications/$PUB/mark-published"
curl -X POST "localhost:8080/publications/$PUB/collect-analytics" \
     -H 'content-type: application/json' -d '{"window": "24h"}'
```

```json
{
  "inserted": true,
  "simulated": true,
  "metrics": { "impressions": 287, "reactions": 10, "comments": 3, "saves": null },
  "derived": { "engagement_rate": 0.05226, "save_rate": null }
}
```

`simulated: true` marks mock numbers as what they are. A metric the platform does not report stays
`null` and every rate derived from it stays `null` - unknown is never recorded as zero. Collecting
again for the same day refreshes that row instead of adding one.

**12. Read the week.**

```bash
curl -X POST localhost:8080/reports/weekly -H 'content-type: application/json' -d '{}'
curl -s "localhost:8080/reports/weekly/$REPORT?format=text"   # $REPORT is the report_id above
```

```
Weekly intelligence - 2026-W39 (Asia/Kolkata)

Learning events: 1
Duplicates: 0
Atoms: 1
Ideas: 2
Drafts: 5
Gate rejected: 0
Approved: 1
Published: 1
Capture to publish (median hours): 0.01

By topic
  security: 1 published, 287 impressions, rate 0.05226

By format
  x_post: 1 published, 287 impressions, rate 0.05226
```

Add `{"deliver": true}` to send it to Telegram. Regenerating the same week refreshes the existing
report rather than creating a near-duplicate. Comparative signals stay low-confidence until there
is enough measured data to support them - the report says "not enough measured publications" rather
than inventing a trend.

**Where it all went.** Every row above is linked back to the original note, and you can see the
whole chain in one query:

```sql
SELECT le.id AS learning_event, ca.id AS atom, ci.id AS idea, it.id AS item,
       pb.id AS publication, pb.dry_run, ae.id AS analytics
  FROM learning_events le
  JOIN content_atoms    ca ON ca.learning_event_id = le.id
  JOIN content_ideas    ci ON ci.content_atom_id   = ca.id
  JOIN content_items    it ON it.content_idea_id   = ci.id
  JOIN publications     pb ON pb.content_item_id   = it.id
  JOIN analytics_events ae ON ae.publication_id    = pb.id;
```

## Running it day to day

Start the worker alongside the API. It owns everything time-based: daily analytics collection, the
weekly report, and an hourly sweep that confirms due publications, releases work abandoned by a
crashed process and dead-letters anything past its retry budget.

```bash
pnpm dev:worker
```

Check on the system with `GET /health/system` - it is the endpoint that distinguishes _up_ from
_making progress_, reporting stalled work (notes captured but never processed, drafts waiting for
approval for days) and recent errors by code.

The full stack, including n8n and Ollama, needs a Docker daemon:

```bash
cp infra/.env.example infra/.env   # fill the placeholders; this file is never committed
infra/scripts/start.sh             # postgres, redis, n8n, ollama
infra/scripts/start.sh --with-app  # ...and api + workers
infra/scripts/health.sh            # per-service health
```

n8n does the scheduling and the Telegram/webhook plumbing; the API keeps the business logic.
Import the workflows with `infra/scripts/n8n-import.sh` and set their credentials in the n8n UI -
the exported JSON never contains a secret. See `docs/workflows.md`.

| Script                           | What it does                                         |
| -------------------------------- | ---------------------------------------------------- |
| `infra/scripts/demo.sh`          | end-to-end demonstration against a running API       |
| `infra/scripts/failure-drill.sh` | proves the system refuses bad input and bad callers  |
| `infra/scripts/health.sh`        | per-service health of the docker stack               |
| `infra/scripts/backup-verify.sh` | takes a backup and restores it into a scratch schema |
| `infra/scripts/n8n-export.sh`    | exports workflows without credential values          |

## Switching on the real thing

Everything above runs offline against mocks. Turning on a real provider is one variable at a time,
and the API refuses to boot on a configuration that does not make sense - a missing credential, or
live publishing with a mock provider. `docs/environment.md` documents every variable.

| To do this                | Set                                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| Real model generation     | `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL=...`                         |
| Real web research         | `RESEARCH_PROVIDER=searxng`, `SEARXNG_BASE_URL=...`                  |
| Real approval in Telegram | `TELEGRAM_PROVIDER=telegram` + bot token, chat id and webhook secret |
| Real scheduling           | `PUBLISHING_PROVIDER=postiz`, `POSTIZ_BASE_URL`, `POSTIZ_API_KEY`    |
| **Actually posting**      | `PUBLISH_MODE=live` - last, and only with a real publishing provider |

`RESEARCH_PROVIDER=fixture`, used above, is a small curated corpus of canonical references for
demos and tests. It exists because the default `mock` provider returns deliberately _synthetic_
sources, and the quality gate blocks any draft whose evidence is synthetic - correct behaviour, but
it stops the demo at the gate. Fixture evidence is stamped `provider = 'fixture'` on every row and
is refused outright when `NODE_ENV=production`.

Before any of this touches a real account, work through **`docs/launch-checklist.md`**. It is
ordered deliberately: verify the external contracts, prove backups restore, switch on read paths
before write paths, and publish last - to a test account first.

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
