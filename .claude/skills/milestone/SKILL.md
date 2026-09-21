---
name: milestone
description: Execute one milestone of the Superhuman Content Engine build plan end to end — inspect, implement, test, self-review, report. Use when the user says "start milestone NN", "continue the build", or names a milestone objective from docs/build-plan.md.
---

# Run a build-plan milestone

The build plan defines 18 milestones. Work **one milestone at a time**, never jump ahead.

## 1. Load the milestone

```bash
rg -n "Milestone NN" docs/build-plan.md
cat docs/milestones/README.md
```

Read the objective, the atomic task list, and the acceptance criteria verbatim. If a previous
milestone report exists in `docs/milestones/`, read it — it records known limitations you may now
be expected to close.

## 2. Inspect before writing

- `git log --oneline -15` and `git diff --stat` — know the current state.
- `rg` for the modules the milestone touches. Reuse what exists; do not recreate it.
- Check `docs/architecture.md` and `docs/file-plan.md` for where new files belong.

## 3. Implement

Smallest coherent slices, in dependency order. For each slice:
- Contracts first (`packages/schemas`), then DB (`packages/db/migrations`), then logic, then the
  HTTP/worker/n8n surface, then tests.
- Every external boundary: zod validation, timeout, bounded retry, typed failure, structured log.
- Every replayable operation: deterministic idempotency key + a DB unique constraint.

## 4. Verify — required, not optional

```bash
pnpm verify                     # typecheck + lint + unit tests
DATABASE_URL=... pnpm test      # includes DB-backed tests
```

Plus at least one *executable* proof specific to the milestone (a `curl` against the running API,
a `psql` query showing the constraint firing, a job run, a replayed webhook). Paste the real output
into the milestone report. Never write "should work".

## 5. Self-review the diff

`git diff` and look for: wrong assumptions, missing validation, duplicate-execution paths, races,
secrets in code/logs/fixtures, swallowed errors, missing migrations, missing observability,
undocumented env vars, unnecessary complexity. Fix everything that belongs to this milestone.

## 6. Report

Write `docs/milestones/NN-<slug>.md` using exactly this structure, then summarize it in chat:

```
STATUS: COMPLETE | BLOCKED
OBJECTIVE:
WHAT I BUILT:
TASKS COMPLETED:        (map every atomic task -> done / n/a + why)
FILES CREATED:
FILES MODIFIED:
TESTS RUN:              (exact commands)
TEST RESULTS:           (real output/counts)
MANUAL VERIFICATION:    (real commands + output)
SECURITY REVIEW:
KNOWN LIMITATIONS:
GIT DIFF SUMMARY:
ACCEPTANCE CRITERIA:    (each criterion + evidence)
RECOMMENDED NEXT MILESTONE:
```

## 7. Commit

`git add -A && git commit -m "milestone NN: <objective>"` — only after `pnpm verify` is green.
