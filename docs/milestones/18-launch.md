# Milestone 18 - End-to-end launch and final audit

**STATUS: COMPLETE** (two limitations carried forward; see below)

**OBJECTIVE:** Prove the complete system with realistic test data and leave the repository usable
by another engineer.

## WHAT I BUILT

An executable acceptance suite that drives one realistic learning note through every stage the
build plan defines - against a real PostgreSQL schema and the real HTTP surface, with only the
four external boundaries substituted - then replays the whole path and injects an outage into each
dependency in turn. Plus the things another engineer needs to use this: a demo script, a launch
checklist, and documentation that matches what the code actually does.

The suite found two real defects, both in the recovery paths. Both are fixed, with tests.

## TASKS COMPLETED

| #    | Atomic task                                   | Result                                                                                                                  |
| ---- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | Create a representative learning event        | the refresh-token-rotation note from `tests/fixtures/learning-notes.ts`, captured through `POST /capture`               |
| 2-4  | Normalization, classification, deduplication  | `POST /learning-events/:id/process` -> `atomized`, `core_engineering` / `security`, `duplicate_of: null`                |
| 5    | Create Content Atom                           | `ca_...` created, `status: ready`, claims cite only stored source ids                                                   |
| 6    | Run research enrichment                       | 3 sources, `evidence_status: supported`, `synthetic_only: false`                                                        |
| 7    | Generate content ideas                        | 2 distinct angles (`insight`, `mental_model`), both queued                                                              |
| 8-12 | All five formats                              | x_post (1 unit), x_thread (4), linkedin_post (1), reel_script (3), carousel (5)                                         |
| 13   | Run quality gate                              | 5/5 `pass` at `gate.v1`; two carry a `TOO_SHORT` warning, no blocking reason                                            |
| 14   | Send to Telegram approval                     | card rendered and sent through the adapter; buttons carry the deterministic action id                                   |
| 15   | Approve one version                           | applied through the **real webhook transport**, replaying the button payload from the card that was sent                |
| 16   | Reject one version                            | `rejected`, note stored, no publication created                                                                         |
| 17   | Regenerate one version                        | v2 created, v1 `superseded` and still readable                                                                          |
| 18   | Schedule approved test content                | `pb_...` `scheduled`, `dry_run: true`, provider id recorded                                                             |
| 19   | Verify publication record                     | exactly one row, with idempotency key, external id, `published_at`                                                      |
| 20   | Run analytics collection                      | one `ae_...`; metrics the platform does not report stay `null`, derived rates `null` with them                          |
| 21   | Generate weekly intelligence                  | `wr_...` for `2026-W39`; counts match the run exactly                                                                   |
| 22   | Verify all records link back                  | a single SQL join from `learning_events` to `analytics_events` returns exactly one row with the expected ids            |
| 23   | Run duplicate execution of the complete path  | `tests/e2e/duplicate-path.test.ts` runs the identical journey a second time                                             |
| 24   | Verify duplicate execution does not duplicate | one learning event, one atom, unchanged sources/ideas/drafts, **one publication**, one analytics row, one weekly report |
| 25   | Run failure injection for a dependency        | four of them: LLM, research, publishing, analytics                                                                      |
| 26   | Verify recovery                               | each one recovers when the dependency returns, without duplicating anything - and the incident stays on the record      |
| 27   | Run full tests                                | `pnpm verify` - 39 files, **628 tests**, green                                                                          |
| 28   | Run lint/type checks                          | included in `pnpm verify` (tsc --noEmit, prettier --check, eslint)                                                      |
| 29   | Review Git diff                               | reviewed; findings below                                                                                                |
| 30   | Remove debug code and temporary data          | no `console.log` outside the two CLIs (eslint-scoped), no TODO/FIXME, no `.only`/`.skip`, no scratch files tracked      |
| 31   | Update README                                 | setup, demo, script table, documentation index, layout                                                                  |
| 32   | Update architecture docs                      | publication-retry exception to the idempotency model; failure model now states failures are recoverable                 |
| 33   | Update setup guide                            | `docs/runbook.md` - demo section and six new troubleshooting rows                                                       |
| 34   | Update workflow catalog                       | `docs/workflows.md` - the three operational workflows were missing; added "what runs where"                             |
| 35   | Update troubleshooting guide                  | `docs/incident-runbook.md` - stuck `failed` events, stranded publications                                               |
| 36   | Create demo script                            | `infra/scripts/demo.sh`                                                                                                 |
| 37   | Create final launch checklist                 | `docs/launch-checklist.md`                                                                                              |
| 38   | Tag/version the first stable release          | `v0.1.0`                                                                                                                |

## DEFECTS FOUND AND FIXED

The first two were found by the failure drill rather than by reasoning about the code, and neither
was covered by the existing tests. The third was found by the review pass over the fix for the
first.

**1. A publication stranded by a provider outage could never reach the provider again.**
After a transient failure the row became `retry_pending`; the hourly sweep moved it to `pending`
"so the next publish run picks it up" - but `schedulePublication` returned _any_ already-claimed
row without calling the provider, and nothing else ever did. The publication could never get an
external id, so it could never be published or measured. It now retries through the same row and
the same idempotency key when the row has no external id and is inside its attempt budget; a row
that has reached the provider is still returned untouched, and a spent budget is left for the
sweep to dead-letter. (ADR-008)

The pre-existing test "recovers after a transient failure without creating a second post" passed
throughout: it asserted one row existed, never that the publication actually went out. It now
asserts `status: scheduled` and a non-null external id, and two new tests pin the other two cases.

**2. `failed` was terminal for a learning event.** A note that failed because the model was
unreachable was stranded permanently - no transition out of `failed` existed. `failed` is now
recoverable; a finished event is still never reopened by a late failure report. A retry cannot
duplicate anything because a learning event has at most one atom by unique index. (ADR-009)

A third, smaller gap: a successful approval request left no `workflow_runs` row, so "the card
never arrived" was not answerable from the database. It now records one like every other stage.

**3. The retry recorded the wrong provider** - found by the post-milestone review, in the fix for
defect 1. A publication claimed while `PUBLISHING_PROVIDER=failing` and then retried successfully
against `mock` kept `provider = 'failing'` on the row, while the external id had been produced by
`mock`. `(provider, external_id)` is unique, so the row both stated a falsehood and enforced
uniqueness against the wrong pair. A successful publish now records the provider and dry-run flag
that actually applied, with a regression test and a live drill:

```
# claimed against a failing provider
 status        | attempts | provider | external_id
 retry_pending |        1 | failing  |
# retried against a working one, same row and same idempotency key
 scheduled     |        2 | mock     | mock-post-1
```

## FILES CREATED

| File                                        | Purpose                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `tests/e2e/harness.ts`                      | builds the real app on a real schema with substitutable boundaries |
| `tests/e2e/journey.ts`                      | the documented path as one replay-tolerant function                |
| `tests/e2e/full-path.test.ts`               | 16 stage and provenance assertions                                 |
| `tests/e2e/duplicate-path.test.ts`          | 11 assertions that the second pass changes nothing                 |
| `tests/e2e/failure-recovery.test.ts`        | 12 assertions across four injected outages                         |
| `packages/adapters/src/research/fixture.ts` | curated offline research corpus, refused in production             |
| `infra/scripts/demo.sh`                     | end-to-end demonstration against a running API                     |
| `docs/launch-checklist.md`                  | what to verify before pointing this at a real account              |
| `docs/milestones/18-launch.md`              | this report                                                        |

## FILES MODIFIED

`packages/core/src/publish.ts` (retry through a claimed row), `packages/core/src/approval.ts`
(workflow run for approval requests), `packages/db/src/repositories/learning-events.ts`
(`failed` is recoverable), `packages/utils/src/env.ts` (`fixture` provider + production refusal),
`packages/adapters/src/research/index.ts`, plus tests for each
(`packages/core/src/publish.test.ts`, `packages/db/src/learning-events.test.ts`,
`packages/adapters/src/research/research.test.ts`) and documentation
(`README.md`, `docs/architecture.md`, `docs/decisions.md`, `docs/environment.md`,
`docs/incident-runbook.md`, `docs/runbook.md`, `docs/workflows.md`,
`docs/milestones/README.md`).

## TESTS AND COMMANDS RUN

```
$ TEST_DATABASE_URL=postgres://sce:sce@localhost:5432/sce_test pnpm verify
  tsc --noEmit                     clean
  prettier --check . && eslint .   clean
  vitest run                       Test Files  39 passed (39)
                                   Tests      628 passed (628)
```

## MANUAL VERIFICATION EVIDENCE

Against a live API (`RESEARCH_PROVIDER=fixture`, `PUBLISH_MODE=dry_run`) on a freshly migrated
database:

```
$ infra/scripts/demo.sh http://localhost:8099
== 0. the API is up and refuses to publish for real
   publish mode           dry_run
== 1-4. capture, normalize, classify, deduplicate
   learning event         le_0mud29kwace2db11468814555
   status                 atomized      topic  security      duplicate of  None
   content atom           ca_0mud29kxe0cb07c794dbd4be9
== 5-6. research enrichment and the canonical atom
   evidence supported   sources 3   synthetic only False   atom status ready   unsupported claims 0
== 8-12. one draft per platform-native format
   generated now 5 / already existed 0    (x_post, x_thread, linkedin_post, reel_script, carousel)
== 13. quality gate
   5 x pass  (two with a TOO_SHORT warning, no blocker)
== 14-17. approval
   approve approved   reject rejected   regenerate it_0mud29lr1fabd39d9d35841a2
== 18-19. schedule and record the publication
   publication pb_0mud29lrj4531d7b299de4be3   status scheduled   dry run True   external id mock-post-4
== 20. analytics
   impressions 999   saves unknown   derived save_rate unknown
== 21. weekly intelligence
   drafts_generated 6   approved 1   rejected_by_human 1   published 1   publications_failed 0
== 23-24. replay the whole path
   same event? ...(duplicate=True)   re-process True (unchanged)   re-research 0 source(s) added
   re-gate True (unchanged)   re-schedule E_NOT_APPROVED   re-collect False (inserted)
   publications 1
```

The provenance chain, read directly from the database afterwards:

```
$ psql "$DATABASE_URL" -x -c "SELECT ... FROM learning_events le
    JOIN content_atoms ca ... JOIN content_ideas ci ... JOIN content_items it ...
    JOIN publications pb ... JOIN analytics_events ae ..."
learning_event  | le_0mud29kwace2db11468814555
atom            | ca_0mud29kxe0cb07c794dbd4be9   evidence_status supported
idea            | ci_0mud29l3r8659b4204df64565
item            | it_0mud29l5jf00a6612353e45fc   format x_post   item_status published
publication     | pb_0mud29lrj4531d7b299de4be3   pub_status published   dry_run t
analytics       | ae_0mud29luxc784c401004e4d7a

 le | atoms | items | pubs | analytics | errors | failed_runs
  1 |     1 |     6 |    1 |         1 |      0 |           0
```

Six items is five drafts plus the one regeneration. One publication, one analytics row, zero
errors, zero failed workflow runs.

```
$ infra/scripts/failure-drill.sh http://localhost:8099
  PASS  short capture returns 422
  PASS  unsigned webhook is rejected (401 or 503)
  PASS  telegram update without a secret does not apply a decision
  PASS  second capture returns the original id
  PASS  unknown content item returns 404
  INFO  system health: healthy
drill complete: 5 passed, 0 failed
```

## SECURITY / SECRETS REVIEW

- `git grep -nE '(api[_-]?key|secret|token|password)\s*[:=]\s*["\x27][^"\x27]{8,}'` returns exactly
  one hit: a test fixture token in `apps/api/src/capture.test.ts`.
- The new `fixture` provider holds no credentials and makes no network calls.
- The demo script reads `CAPTURE_API_TOKEN` from the environment and never prints it; it refuses to
  run unless the API reports `publish_mode: dry_run`.
- The publication retry path widens no authorization: it still requires an `approved` item, still
  honours the dry-run guard, and still sends the same idempotency key.
- Making `failed` recoverable cannot resurrect rejected or published content - those are content
  item states, governed by a separate transition table that was not changed.

## GIT DIFF SUMMARY

Two commits. The first adds the end-to-end suite, the fixture provider and the two recovery fixes
(14 files, +1681/-10). The second is documentation, the demo script and the launch checklist.

Reviewed as a senior engineer would: the retry condition is narrow and each clause is load-bearing
(no external id, retryable status, budget remaining); the state-machine change adds only forward
edges; the fixture provider cannot be selected in production; the e2e harness substitutes
boundaries and nothing else, so the suite exercises production routing, SQL and transitions.

## KNOWN LIMITATIONS

1. **`infra/.env.example` could not be updated in this session.** The project's own permission
   rules deny reading `./.env.*`, which also matches the committed template, and the request to
   narrow that rule was refused as self-modification. The file therefore does not yet list
   `fixture` among the `RESEARCH_PROVIDER` values. One line to add under the provider section:
   `# RESEARCH_PROVIDER=mock | fixture | searxng | disabled | failing  (fixture is demo-only and refused in production)`.
   The authoritative list is in `docs/environment.md` and `packages/utils/src/env.ts`, and the env
   validator rejects anything else, so nothing is silently wrong.
2. **The `v0.1.0` tag exists locally but is not on the remote.** The branch pushed fine;
   `git push origin v0.1.0` returns HTTP 403, so this session's credentials cover `refs/heads`
   but not `refs/tags`. The annotated tag points at `c720ead` and needs one command from a
   machine with tag-push rights: `git push origin v0.1.0`.
3. **Docker Compose still has not been started here** (no Docker daemon). It is validated
   statically by `tests/infra/compose.test.ts`; the first `infra/scripts/start.sh` on a Docker host
   remains a verification step, and is on the launch checklist.
4. **Postiz, SearxNG and Telegram analytics contracts remain assumptions**, recorded as such in
   `docs/external-apis.md`. Every one of them defaults to a mock.
5. **The `fixture` corpus is curated reference material, not fetched search results.** This
   environment's network policy blocks general web hosts, so the entries could not be fetch-checked
   here. They are canonical documentation and standards landing pages, they are refused in
   production, and every source they produce is stamped `provider = 'fixture'` in the database.
6. **The weekly report's comparative signals stay low-confidence** on a small dataset, by design -
   one publication is not a trend. The suite asserts the honest "not enough measured publications"
   basis rather than a fabricated insight.

## FINAL AUDIT: PASS

- Complete learning-to-analytics path is demonstrable: `tests/e2e/full-path.test.ts` and
  `infra/scripts/demo.sh`, both run and recorded above.
- Duplicate path is safe: `tests/e2e/duplicate-path.test.ts`, plus the replay section of the demo.
- Failure path is demonstrable: `tests/e2e/failure-recovery.test.ts` and
  `infra/scripts/failure-drill.sh`.
- Documentation is sufficient for a clean setup: README setup section, `docs/runbook.md`,
  `docs/environment.md`, `docs/launch-checklist.md`.
- No accidental secrets or debug artifacts: scans above.

## RECOMMENDED NEXT STEP

Not a milestone - the build plan is finished. The next real step is the launch checklist, in its
order: verify the external contracts in `docs/external-apis.md` against the live services, bring up
the Docker stack on a Docker host, then switch on providers one at a time, publishing last and to a
test account first.
