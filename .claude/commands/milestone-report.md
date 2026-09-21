---
description: Write the required completion report for the current milestone into docs/milestones/
argument-hint: "<milestone number>"
---

Produce the build plan's mandatory completion report for milestone $1.

Gather real evidence first: `git diff --stat`, the exact test commands and their output, manual
verification commands (`curl`, `psql`, worker runs) with their real output, and a secrets check.

Write `docs/milestones/$1-<slug>.md` with: STATUS, OBJECTIVE, WHAT I BUILT, TASKS COMPLETED (every
atomic task mapped to done / n-a + reason), FILES CREATED, FILES MODIFIED, TESTS RUN, TEST RESULTS,
MANUAL VERIFICATION, SECURITY REVIEW, KNOWN LIMITATIONS, GIT DIFF SUMMARY, ACCEPTANCE CRITERIA
(each with evidence), RECOMMENDED NEXT MILESTONE.

Then update `docs/milestones/README.md` (the progress index) and summarize in chat in under 15 lines.
