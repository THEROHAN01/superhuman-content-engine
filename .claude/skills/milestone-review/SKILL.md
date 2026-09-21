---
name: milestone-review
description: Audit the most recently completed milestone against the repository's real state and return PASS/FAIL with evidence. Use when the user says "run the milestone review", "review the last milestone", or before starting the next milestone.
---

# Milestone review loop

Review the **repository**, not the previous explanation. Assume the report may be optimistic.

1. Re-read the milestone objective and atomic tasks in `docs/build-plan.md`.
2. Inspect the diff: `git diff <previous-tag-or-commit>..HEAD` (use `git log --oneline`).
3. Re-run the tests yourself: `pnpm verify`, plus DB tests with `DATABASE_URL` set. Do not trust
   recorded output.
4. Inspect failure paths: force one external adapter to fail (`*_PROVIDER=failing` or a stubbed
   transport) and confirm the state machine records an error rather than a success.
5. Check idempotency: replay each new webhook/job/approval/publish twice, assert one effect.
   `rg -n "ON CONFLICT|idempotency" packages apps`
6. Check secrets and logging: `git grep -nIE "(sk-|ghp_|xox|BEGIN (RSA|OPENSSH))"`, confirm
   `.env` is ignored, confirm pino redaction covers new fields.
7. Check DB integrity: migrations re-run cleanly on an empty DB *and* on the dev DB; constraints
   and indexes exist (`\d+ <table>`).
8. Check external API handling: timeout, retry, rate-limit and partial-failure paths exist and
   are tested with fakes — no live calls.
9. Check docs: README, architecture, environment, workflow catalog, troubleshooting all updated.
10. Verify **every** acceptance criterion explicitly, with evidence.

Return:

```
VERDICT: PASS | FAIL
ACCEPTANCE CRITERIA: <criterion> -> PASS/FAIL + evidence
ISSUES FOUND:
FIXES MADE:
TESTS AFTER FIXES:
REMAINING RISKS:
READY FOR NEXT MILESTONE: yes/no
```

Fix defects that belong to the reviewed milestone. **Do not implement the next milestone.**
