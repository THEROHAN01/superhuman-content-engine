---
name: db-migration
description: Add or change a PostgreSQL migration in packages/db safely (forward-only SQL, constraints, indexes, enum mirroring, verification against a real database). Use whenever a table, column, constraint, index, or status enum changes.
---

# Database migration procedure

Migrations are **forward-only, hand-written SQL**, applied by `packages/db/src/migrate.ts` inside a
transaction, tracked in `schema_migrations`.

## Rules

1. Never edit a committed migration. Add `packages/db/migrations/NNNN_<description>.sql` with the
   next zero-padded number.
2. Write idempotent DDL: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, `DROP ... IF EXISTS`.
3. Every table gets: text primary key with a typed prefix, `created_at timestamptz NOT NULL
   DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()` plus the `set_updated_at`
   trigger (migration 0001 defines the function).
4. Status columns are `TEXT NOT NULL CHECK (col IN (...))` and **must** match the zod enum in
   `packages/schemas/src/enums.ts`. Change both in the same commit; `packages/db/test/enum-parity`
   asserts it.
5. Anything that can arrive twice needs a `UNIQUE` constraint on its idempotency/external key —
   deduplication in application code alone is not acceptable.
6. Add indexes for the access paths you actually query: status, scheduled_at, foreign keys,
   topic, external ids.
7. Foreign keys carry an explicit `ON DELETE` rule. Provenance links use `ON DELETE RESTRICT`.

## Verify

```bash
# empty database
createdb sce_migrate_check && DATABASE_URL=postgres://.../sce_migrate_check pnpm db:migrate
# existing dev database (idempotent re-run)
pnpm db:migrate && pnpm db:migrate
# constraint actually fires
psql "$DATABASE_URL" -c "insert into ... ;" # expect: duplicate key value violates unique constraint
pnpm test -- packages/db
dropdb sce_migrate_check
```

Record the real psql output in the milestone report.
