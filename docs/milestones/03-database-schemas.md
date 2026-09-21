# Milestone 03 - Database and shared schemas

**STATUS: COMPLETE**

**OBJECTIVE:** Create durable internal state and stable contracts between workflows.

## WHAT I BUILT

The foundation every later milestone builds on: `@sce/utils` (env validation, prefixed ids,
content hashing, idempotency keys, constant-time compare, retry with backoff, redacting logger),
`@sce/schemas` (zod contracts and status enums for the whole pipeline plus platform constraints),
and `@sce/db` (forward-only SQL migrations with checksum drift detection, pool with ISO-timestamp
parsing, learning-event and operations repositories, idempotent seed data, a CLI, and a
per-file-schema test harness).

## TASKS COMPLETED

| #    | Atomic task                                              | Result                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Choose the database access approach                      | `pg` + hand-written SQL (ADR-003); no ORM                                                                                                                                                                        |
| 2    | Migration strategy                                       | forward-only numbered SQL, transactional, checksum-tracked, refuses to run when an applied file changed                                                                                                          |
| 3-10 | Define the core tables                                   | `learning_events`, `content_atoms`, `source_documents`, `content_ideas`, `content_items`, `approvals`, `publications`, `analytics_events`, `workflow_runs`, `error_events`, plus `jobs` and `webhook_deliveries` |
| 11   | created_at/updated_at                                    | on all 12 tables; `updated_at` maintained by trigger (test proves it fires)                                                                                                                                      |
| 12   | Stable primary keys                                      | typed prefixed text ids (`le_`, `ca_`, `ci_`, `it_`, `ap_`, `pb_`, `ae_`, ...)                                                                                                                                   |
| 13   | Status fields/enums                                      | TEXT + CHECK mirroring `packages/schemas/src/enums.ts`                                                                                                                                                           |
| 14   | Unique constraints for external ids and idempotency keys | 9 unique indexes; see `docs/data-model.md`                                                                                                                                                                       |
| 15   | Indexes for access paths                                 | status+time, correlation id, topic, scheduled time, foreign keys, publication lookup                                                                                                                             |
| 16   | Seed/example records                                     | `pnpm db:seed` (3 realistic notes, idempotent) and `--remove` deletes exactly those rows                                                                                                                         |
| 17   | JSON schemas / typed interfaces for workflow payloads    | zod contracts in `@sce/schemas`, `CONTRACT_VERSION` and `CONTENT_ATOM_SCHEMA_VERSION` recorded                                                                                                                   |
| 18   | Tests for schema validation and DB constraints           | 22 schema tests, 15 constraint tests, 6 migration tests, 9 repository tests                                                                                                                                      |
| 19   | Run migrations against an empty database                 | verified against a fresh `sce_check` database                                                                                                                                                                    |
| 20   | Run migrations against the running dev database          | verified against `sce_dev`, twice (second run applied nothing)                                                                                                                                                   |
| 21   | Verify duplicate keys are rejected                       | verified in tests and by hand in psql (output below)                                                                                                                                                             |

## FILES CREATED

`packages/utils/src/{env,errors,ids,hash,logger,retry,time,index}.ts` + `utils.test.ts`;
`packages/schemas/src/{enums,common,platform-constraints,learning-event,source-document,content-atom,content-idea,content-item,approval,publication,analytics,operations,index}.ts` + `schemas.test.ts`;
`packages/db/migrations/0001_init.sql`;
`packages/db/src/{pool,migrate,seed,cli,testing,index}.ts`,
`packages/db/src/repositories/{learning-events,operations}.ts`,
`packages/db/src/{migrations,constraints,enum-parity,learning-events}.test.ts`;
`docs/data-model.md`.

## TESTS RUN

```
pnpm verify                                                  # typecheck + lint + tests
TEST_DATABASE_URL=postgres://sce:sce@localhost:5432/sce_test pnpm test
DATABASE_URL=postgres://.../sce_check pnpm db:migrate        # empty database
DATABASE_URL=postgres://.../sce_dev   pnpm db:migrate        # running dev database, twice
DATABASE_URL=postgres://.../sce_dev   pnpm db:seed           # twice
```

## TEST RESULTS

- With a database: **110 passed (8 files)**.
- Without a database: **80 passed, 30 skipped** - DB suites skip visibly rather than silently
  passing.
- Empty database: `applied 1 migration(s): 0001_init`. Re-run: `database already up to date`.
- Seed: `3 created, 0 already present`, then `0 created, 3 already present`.

## MANUAL VERIFICATION

```
$ psql sce_dev -c "insert into learning_events ... (duplicate content_hash)"
ERROR:  duplicate key value violates unique constraint "learning_events_content_hash_key"
DETAIL:  Key (content_hash)=(d6e3759e...) already exists.

$ psql sce_dev -c "\d publications"
Indexes:
    "publications_idempotency_key" UNIQUE, btree (idempotency_key)
    "publications_provider_external_key" UNIQUE, btree (provider, external_id) WHERE external_id IS NOT NULL
    "publications_status_schedule_idx" btree (status, scheduled_at)

$ psql sce_dev -c "\dt"   -> 13 tables (12 domain tables + schema_migrations)
```

## SECURITY REVIEW

- `DATABASE_URL` is added to the pino redaction list; connection strings never reach a log line.
- All queries are parameterized; no string-concatenated SQL anywhere in `packages/db`.
- `db:reset` refuses without `--force` and refuses entirely unless the URL is local or clearly a
  `_test`/`_dev`/`_check` database.
- `TEST_DATABASE_URL` is rejected by env validation unless the database name ends in `_test`, so a
  test run cannot truncate a real database.
- Seed data contains no credentials and is removable by tag.

## KNOWN LIMITATIONS

1. Repositories exist only for the tables this milestone needs (`learning_events`, operations);
   the rest are added with their own milestones, against the same schema.
2. `weekly_reports` is not created yet - it belongs to Milestone 16.
3. Monotonic status transitions are enforced in the repository layer (allowed-predecessor list)
   rather than by a database trigger; the constraint tests cover the entity-level invariants that
   matter most (duplicate shape, published-needs-external-id).

## ACCEPTANCE CRITERIA

| Criterion                                               | Evidence                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Migrations are reproducible                             | applied cleanly to an empty database and to the dev database; re-runs are no-ops; checksum drift aborts (test)         |
| Core tables exist                                       | `\dt` lists 13 tables; a migration test asserts the exact set                                                          |
| Constraints prevent obvious duplication                 | 15 constraint tests + the psql duplicate-key output above                                                              |
| Seed/test data can be created and removed safely        | seed is idempotent and `--remove` deletes exactly the seeded rows (test)                                               |
| Shared payload schemas are versioned or clearly defined | `CONTRACT_VERSION`, `CONTENT_ATOM_SCHEMA_VERSION`, `schema_version` column, and an enum-parity test binding zod to SQL |

## RECOMMENDED NEXT MILESTONE

04 - Learning Inbox and capture API.
