# Milestone 14 - GitHub to content opportunities

**STATUS: COMPLETE**

**OBJECTIVE:** Turn meaningful engineering progress into content opportunities automatically.

## WHAT I BUILT

A signed GitHub webhook that turns merged pull requests and published releases into learning
events - the same entry point a hand-written note uses - behind a significance filter that always
explains itself and a manual override for when it is wrong.

## TASKS COMPLETED

| #   | Atomic task                                                  | Result                                                                                                 |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | Define which events matter                                   | merged PRs and published releases; labels act as the "this one matters" marker                         |
| 2   | Webhook/event ingestion                                      | `POST /webhooks/github`                                                                                |
| 3   | Verify signature/authenticity                                | HMAC-SHA256 over the raw body, constant-time compare; 503 when no secret is configured                 |
| 4   | Capture repository, ref, commit/PR id, title, URL, timestamp | all stored, with `captured_at` set to the merge/release time                                           |
| 5   | Filter trivial changes                                       | title patterns, description length, single-file micro-diffs, empty releases                            |
| 6   | Extract changed-file summary                                 | additions/deletions/changed files in the learning text and in `context.stats`                          |
| 7   | Extract problem/goal from the PR description                 | the description is quoted verbatim; extraction of the insight is the atom stage's job                  |
| 8   | Extract engineering decision/lesson candidates               | scored higher when the description explains a cause or trade-off; the atom builder does the extraction |
| 9   | Generate an opportunity only for meaningful changes          | filtered events create nothing and say why                                                             |
| 10  | Link the opportunity to the GitHub URL                       | in the learning text and in `context.url`                                                              |
| 11  | Store the source event id                                    | `external_id` = `pr:<id>` / `release:<id>`                                                             |
| 12  | Deduplicate repeated webhook delivery                        | two layers: delivery id and event id                                                                   |
| 13  | Manual override                                              | `POST /github/opportunities/force`, recorded as `significance.forced`                                  |
| 14  | Tests for meaningful and trivial changes                     | 11 fixtures, exercised at adapter, service and HTTP level                                              |
| 15  | Run a test PR/release event                                  | live drill below                                                                                       |

## FILES CREATED

`packages/adapters/src/github/{signature,events,significance,index}.ts` + `github.test.ts`;
`packages/core/src/github-opportunity.ts` + `github-opportunity.test.ts`;
`apps/api/src/routes/github.ts` + `apps/api/src/github.test.ts`;
`apps/api/src/plugins/raw-body.ts`; `tests/fixtures/github-events.ts`; `docs/github-events.md`.

## FILES MODIFIED

`packages/adapters/src/index.ts`, `packages/core/src/index.ts`, `apps/api/src/app.ts`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify     # 473 tests
bash /tmp/live-github.sh              # signed delivery, redelivery, re-sent PR, pipeline handoff
```

## TEST RESULTS

473 passed. Coverage: signature verification (exact bytes, whitespace-changed body rejected, wrong
secret, missing/malformed header, Buffer input), event parsing (merged PR fields, unmodelled event
types, stable external id), all 11 significance fixtures, verbatim learning text with the source
link, ingestion (provenance, duplicate event, edited-and-resent PR, forced override, handoff to the
normal pipeline, workflow-run recording, unparseable payload), and the HTTP surface (accepted
delivery, five rejection modes, redelivery, cross-delivery deduplication, filtered event, force,
and the no-secret refusal).

## MANUAL VERIFICATION

```
$ # wrong signature
  http 401 E_BAD_SIGNATURE

$ # correctly signed merged PR
  {'status':'captured','reason':'description explains a decision or a cause',
   'learning_event_id':'le_0much5v7h2ef65a27b54d4a7f'}

$ # same delivery id again ->  duplicate_delivery
$ # same PR, new delivery id ->  duplicate
$ psql -> learning_events=1
$ psql -> deliveries=2 processed=2

$ # and it flows through the normal pipeline
  {'status':'atomized','content_atom_id':'ca_0much5vcy5f505cc9e1c7461e'} topic: backend
```

## SECURITY REVIEW

- Signature verification runs on the raw bytes before the payload is used for anything; a test
  proves that a body re-serialized with different whitespace is rejected.
- Constant-time comparison; missing/malformed/mismatch are distinguished for diagnostics but all
  refuse equally.
- No secret configured means 503, not "accept anything" - an unauthenticated webhook would let
  anyone inject content into the pipeline.
- The force endpoint is behind the operator bearer token.
- GitHub text is stored verbatim but never executed or interpolated into a shell/SQL context; it
  reaches prompts as quoted note material, the same as any captured note.

## KNOWN LIMITATIONS

1. Not exercised against real GitHub deliveries - no installation or secret here. The signature
   scheme (`X-Hub-Signature-256`, HMAC-SHA256 over the raw body) is GitHub's documented one and is
   tested both ways with a local signer.
2. Changed-file _names_ are not fetched; only the counts GitHub includes in the PR payload. Getting
   file paths needs an API call with a token, which would add a credential this milestone does not
   otherwise need.
3. The significance filter is heuristic. It is tuned to be permissive (a human approves everything
   later) and every decision is explained and overridable.
4. `push` events and labelled-milestone events are not handled; merged PRs and releases cover the
   same ground with far less noise. Adding them is a parser change plus fixtures.

## ACCEPTANCE CRITERIA

| Criterion                                                   | Evidence                                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Meaningful engineering events produce opportunities         | live drill captured a merged PR and it atomized through the normal pipeline                                            |
| Duplicate webhook deliveries do not duplicate opportunities | same delivery -> `duplicate_delivery`; same PR via another delivery -> `duplicate`; one learning event in the database |
| Every opportunity links back to GitHub                      | URL in the learning text and in `context.url`; repository, ref, SHA and author stored                                  |
| Trivial changes are filtered or explicitly ignored          | dependency bumps, empty descriptions, micro-diffs and empty releases all filtered with a stated reason, and forcible   |

## RECOMMENDED NEXT MILESTONE

15 - Analytics collection and normalization.
