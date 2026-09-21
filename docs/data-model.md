# Data model

Source of truth: `packages/db/migrations/*.sql` (structure) and `packages/schemas/src/*` (payload
contracts). This page explains intent; the files hold the detail.

## Tables

| Table                | Holds                                               | Key uniqueness guarantee                                                   |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| `learning_events`    | every captured note, raw text preserved verbatim    | `content_hash` unique among non-duplicates; `(source, external_id)` unique |
| `content_atoms`      | the canonical structured object per learning event  | one atom per `learning_event_id`                                           |
| `source_documents`   | research evidence attached to an event or atom      | `(content_atom_id, canonical_url)` unique                                  |
| `content_ideas`      | distinct content opportunities derived from an atom | `(content_atom_id, dedupe_hash)` unique                                    |
| `content_items`      | platform-native drafts, versioned                   | `(content_idea_id, format, version)` unique                                |
| `approvals`          | append-only human decisions                         | `action_id` unique; `(channel, external_callback_id)` unique               |
| `publications`       | scheduling/publishing attempts                      | `idempotency_key` unique; `(provider, external_id)` unique                 |
| `analytics_events`   | normalized metrics per publication                  | `(publication_id, metric_window, collected_for)` unique                    |
| `workflow_runs`      | execution records keyed by correlation id           | -                                                                          |
| `error_events`       | failures with kind, code and redacted context       | -                                                                          |
| `jobs`               | durable background work                             | `(job_type, dedupe_key)` unique **while pending or running**               |
| `webhook_deliveries` | inbound deliveries, recorded before processing      | `(provider, delivery_id)` unique                                           |

## Invariants the database enforces

1. **One note, one event.** `learning_events_content_hash_key` is a partial unique index over
   non-duplicate rows, so two concurrent captures of the same thought cannot both insert.
2. **A duplicate keeps its provenance.** `status = 'duplicate'` requires `duplicate_of`, and a row
   can never be its own duplicate.
3. **Provenance cannot be deleted.** Foreign keys along the chain use `ON DELETE RESTRICT`, so an
   event with an atom, or an atom with drafts, cannot be removed silently.
4. **One canonical atom per event**, so every format derives from the same object.
5. **Regeneration versions, never overwrites.** `(content_idea_id, format, version)` is unique and
   the superseded row keeps `superseded_by`.
6. **A published row must carry an external id** unless it was a dry run - a "published" record
   with nothing on the provider side is impossible.
7. **One outstanding job per dedupe key.** The unique index is partial over
   `status IN ('pending','running')`, so a job can legitimately run again later.
8. **Unknown metrics stay unknown.** Metrics live in a JSONB document whose fields are nullable;
   nothing coerces a missing metric to `0`.

## Migration policy

Forward-only, numbered SQL in `packages/db/migrations/`, applied in a transaction by
`packages/db/src/migrate.ts` and recorded in `schema_migrations` with a checksum. Editing an
applied migration makes the runner abort with a message telling you to add a new one; a Claude
hook blocks the edit in the first place.

```bash
pnpm db:status           # what is applied
pnpm db:migrate          # apply pending migrations (idempotent)
pnpm db:seed             # example rows, tagged 'seed'
pnpm db:seed --remove    # delete exactly those rows
pnpm db:reset --force    # local/test databases only
```

## Testing

`packages/db/src/testing.ts` gives each DB-backed test file its own PostgreSQL schema (created,
migrated, dropped), selected through the connection's `options` parameter. Without
`TEST_DATABASE_URL` those suites are **skipped, not stubbed**: a run without a database reports
skips so nobody mistakes it for coverage.
