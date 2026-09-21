---
description: Run the full verification gate (typecheck, lint, unit + DB tests) and report real results
---

Run the repository's verification gate and report actual output — never a summary you assume.

```bash
pnpm verify
```

If `pg_isready` succeeds, also run the DB-backed suite with `DATABASE_URL` set (see
`docs/environment.md` for the local value) and report how many DB tests ran versus skipped.

For each failure: the failing test, the root cause (read the code, don't guess), and the fix.
Fix the failures, re-run, and report the final state. Do not weaken or skip a test to get green.
