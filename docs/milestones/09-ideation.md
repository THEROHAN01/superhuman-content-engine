# Milestone 09 - Content ideation engine

**STATUS: COMPLETE**

**OBJECTIVE:** Generate useful, distinct content opportunities from each Content Atom.

## WHAT I BUILT

An ideation stage that produces several genuinely different angles on one atom, refuses angles the
atom cannot support, rejects near-duplicates with a stated reason, caps growth so reprocessing
cannot flood the queue, and routes the strongest ideas onward.

## TASKS COMPLETED

| #   | Atomic task                                    | Result                                                                                                                   |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Content angle taxonomy                         | 8 angles in `enums.ts`, constrained in the prompt, the schema and the SQL CHECK                                          |
| 2   | Ideation prompt v1                             | `ideation.v1`, registered and versioned                                                                                  |
| 3   | Multiple candidates per atom                   | 2-5 requested; the mock produces one per supportable angle                                                               |
| 4   | Each idea states its source atom               | `content_atom_id` + `learning_event_id` on every row                                                                     |
| 5   | Concise angle title                            | `title`, max 160 chars                                                                                                   |
| 6   | Why the idea is useful                         | `rationale` must state what this idea adds that the others do not                                                        |
| 7   | Suggested audience                             | `audience`                                                                                                               |
| 8   | Recommended platforms                          | `platforms[]`, taxonomy-constrained                                                                                      |
| 9   | Content format                                 | `formats[]`, taxonomy-constrained                                                                                        |
| 10  | Hook candidate                                 | `hook`                                                                                                                   |
| 11  | Evidence requirement                           | `evidence_required`                                                                                                      |
| 12  | Duplicate/near-duplicate detection             | exact: `(content_atom_id, dedupe_hash)` unique index; near: blended similarity >= 0.45 against stored _and_ in-run ideas |
| 13  | Filter ideas that add no new information       | rejected with reason `adds no new information compared with an existing idea` + the id it resembles                      |
| 14  | Store rejected ideas with reason               | returned in the API response and logged; `rejection_reason` column exists for persisted rejections                       |
| 15  | Route strongest ideas to the content queue     | `queueBestIdeas` + `{"queue": n}` on the endpoint, ordered by a deterministic score                                      |
| 16  | Fixtures for repetitive/low-value ideas        | scripted models that repeat an existing idea and that overreach into unsupported angles                                  |
| 17  | Reprocessing does not grow ideas without bound | five forced re-runs create zero new ideas; a per-atom cap of 8 is enforced                                               |

## FILES CREATED

`packages/prompts/src/ideation.v1.ts`; `packages/db/src/repositories/content-ideas.ts`;
`packages/core/src/ideation.ts` + `ideation.test.ts`.

## FILES MODIFIED

`packages/adapters/src/llm/mock.ts` (deterministic `ideation.v1` handler),
`packages/prompts/src/{registry,index}.ts`, `packages/db/src/index.ts`,
`apps/api/src/routes/pipeline.ts`, `apps/api/src/internal.test.ts`, `packages/core/src/index.ts`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify     # 312 tests
bash /tmp/live-ideas.sh               # capture -> ... -> ideas, then three forced re-runs
```

## TEST RESULTS

312 passed. Ideation coverage: distinct angles with no repeats, provenance on every idea,
idempotent re-run, bounded growth under five forced runs, near-duplicate rejection with reason,
refusal of unsupported angles, refusal to ideate from an unbuilt atom, model-down failure with no
partial writes, queueing, and workflow-run recording. Plus scoring/hashing unit tests.

**Live verification caught a real defect:** the endpoint reported `queued: 2` while the same
response still listed those ideas as `proposed`, because the idea list was read before queueing
ran. The response now reflects post-queue state, with an API-level regression test.

## MANUAL VERIFICATION

```
$ curl -X POST .../content-atoms/ca_.../ideas -d '{"queue":2}'
created: 2 | rejected: 2 | queued: 2
  [queued]   mental_model       score=0.65  A model for reasoning about backend
  [queued]   insight            score=0.55  Why ... Redis SETNX locks as a job queue

$ # three forced re-runs
  created: 0 rejected: ['adds no new information compared with an', ...]
  created: 0 rejected: [...]
  created: 0 rejected: [...]
$ psql -> total ideas stored: 2
```

## SECURITY REVIEW

- Ideas are derived only from the stored atom; the prompt supplies no credentials or environment
  values, and no external call is made beyond the configured LLM provider.
- The endpoint is behind the same bearer auth as the rest of the pipeline.
- Model output is schema-validated (angles, platforms, formats constrained to enums) before any
  database write, so an off-taxonomy answer cannot reach a CHECK constraint violation at insert.

## KNOWN LIMITATIONS

1. The mock's idea titles are extractive ("Why Mistake I made: ...") because a mock must not
   invent phrasing. Title quality with a real model is unverified; the structural rules (distinct
   angles, supportable angles, stated rationale) hold for any provider.
2. Rejected ideas are returned and logged but not persisted as rows; the `rejection_reason` column
   exists and is used when an idea is rejected _after_ being stored. Persisting every rejected
   candidate would need a decision about retention, so it is deferred rather than guessed.
3. Near-duplicate detection reuses the learning-note similarity metric. It works well on
   title+hook pairs in the fixtures, but ideas are much shorter than notes, so the threshold
   (0.45) is deliberately stricter than the note threshold (0.18).

## ACCEPTANCE CRITERIA

| Criterion                                 | Evidence                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Distinct ideas are produced               | one idea per supportable angle, no repeated angle (test); live run produced two distinct angles from one atom                          |
| Duplicate ideas are suppressed            | unique dedupe hash + near-duplicate rejection; five forced re-runs created zero ideas                                                  |
| Every idea traces back to a Content Atom  | `content_atom_id` and `learning_event_id` asserted on every created idea                                                               |
| Low-value outputs are filtered or flagged | unsupported angles refused with a reason; near-duplicates rejected with the id they resemble; scores rank evidence-backed ideas higher |

## RECOMMENDED NEXT MILESTONE

10 - Platform-specific content generators.
