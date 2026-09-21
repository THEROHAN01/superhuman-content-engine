# Milestone 08 - Canonical Content Atom

**STATUS: COMPLETE**

**OBJECTIVE:** Create the single structured object from which all content formats are derived.

## WHAT I BUILT

The atom build stage: a versioned prompt that structures one learning note plus its evidence into
the canonical object, with validation that rejects fabricated citations, unbacked claims,
evidence upgrades and half-built bodies. Failed transformations are stored with their error state
and are re-runnable.

## TASKS COMPLETED

| #   | Atomic task                                   | Result                                                                                            |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Content Atom v1 schema                        | `contentAtomBody` + `contentAtom` + the stricter `readyContentAtom`                               |
| 2   | Source learning event id                      | `learning_event_id`, `ON DELETE RESTRICT`                                                         |
| 3   | Topic and subtopics                           | `primary_topic`, `secondary_topics` (taxonomy-constrained)                                        |
| 4   | Problem/question                              | `body.problem`                                                                                    |
| 5   | Core insight                                  | `body.core_insight`                                                                               |
| 6   | First-principles explanation                  | `body.first_principles`                                                                           |
| 7   | Example                                       | `body.example`, nullable                                                                          |
| 8   | Implementation details                        | `body.implementation_details`, nullable                                                           |
| 9   | Mistake / failure mode                        | `body.failure_mode`, nullable                                                                     |
| 10  | Mental model                                  | `body.mental_model`, nullable                                                                     |
| 11  | Personal observation                          | `body.personal_observation` - only when the note states it in the first person (tested both ways) |
| 12  | Evidence/source links                         | `body.claims[].source_ids` referencing `source_documents`                                         |
| 13  | Content-angle candidates                      | `body.angle_candidates`, taxonomy-constrained                                                     |
| 14  | Confidence/evidence status                    | `confidence` + `evidence_status` with a no-upgrade rule                                           |
| 15  | Preserve raw source reference                 | atom -> learning event -> `raw_text`, asserted unchanged after build                              |
| 16  | created/updated/version fields                | `created_at`, `updated_at`, `schema_version`, `atomized_at`, `generator_version`                  |
| 17  | Transformation workflow                       | `buildContentAtom` + `POST /content-atoms/:id/build`                                              |
| 18  | Validate atom against schema                  | `readyContentAtom` gate before storing as ready                                                   |
| 19  | Store failed transformations with error state | status `failed` + `error` + `error_events` row; a later success clears the error                  |
| 20  | Fixture Content Atoms                         | built from the shared note fixtures; scripted models cover the adversarial cases                  |
| 21  | Document the data lifecycle                   | `docs/pipeline.md` section 5                                                                      |

## FILES CREATED

`packages/prompts/src/atom.v1.ts`; `packages/core/src/atom.ts` + `atom.test.ts`.

## FILES MODIFIED

`packages/adapters/src/llm/{mock,mock-knowledge}.ts` (deterministic `atom.v1` handler that extracts
structure from the note and never adds knowledge), `packages/prompts/src/{registry,index}.ts`,
`packages/db/src/repositories/content-atoms.ts` (error clearing), `apps/api/src/routes/pipeline.ts`,
`packages/core/src/index.ts`, `docs/pipeline.md`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify      # 298 tests
bash /tmp/live-atom.sh                 # capture -> process -> research -> build -> rebuild
```

## TEST RESULTS

298 passed. The 14 atom tests cover: a complete build with provenance intact, one atom per event,
idempotent rebuild, claim grading, downgrade of an unbacked "supported" claim, rejection of a
fabricated citation, rejection of an incomplete body, model-unreachable failure with error state,
recovery clearing the error, research-failed passthrough, the synthetic-evidence ceiling, failure
mode extraction, personal-observation handling in both directions, and unknown atom.

**Live verification caught a real defect.** The first implementation let the build step promote
evidence from `needs_review` to `partially_supported` when the model's claims looked well-cited -
meaning synthetic mock sources could have been presented as partial support. The final status is
now the _weaker_ of the research outcome and the claim grading, with a regression test; the live
re-run now reports `needs_review`.

## MANUAL VERIFICATION

```
$ curl -X POST .../content-atoms/ca_.../build
status        : ready
evidence      : needs_review | unsupported claims: 0      (mock sources cannot upgrade evidence)
problem       : Why does this matter: Mistake I made: I used Redis SETNX locks as a job queue?
first_princ   : Locks expire, so when a worker pauses longer than the TTL two workers believe...
failure_mode  : Mistake I made: I used Redis SETNX locks as a job queue.
personal      : Mistake I made: I used Redis SETNX locks as a job queue.
angles        : ['failure_mode', 'insight']
claims        : [('supported', 3)]

$ # again
{'status': 'ready', 'unchanged': True, 'evidence_status': 'needs_review'}

$ psql: event -> atom -> sources: le_0mubq8nol... -> ca_0mubq8npe... -> 5
```

## SECURITY REVIEW

- The prompt forbids inventing facts, sources and personal experience; the code enforces the parts
  that are checkable (citation validity, claim/source consistency, evidence ceiling) rather than
  trusting the instruction.
- Source ids are validated against the atom's own sources, so a model cannot smuggle in a
  reference to another user's or another atom's evidence.
- Model output is size-bounded by the schema (field maxima) before it reaches the database.

## KNOWN LIMITATIONS

1. With the mock provider the body is extractive: it reuses the note's sentences rather than
   rewriting them. That is deliberate (a mock must not invent), so the _content quality_ of a real
   build is unverified until an Ollama instance is available. The structural contract holds for any
   provider.
2. `mental_model` and `implementation_details` are rarely populated by the mock; a real model will
   fill more of them. Emptiness is visible, not hidden.
3. Claim extraction is single-claim in the mock. The schema supports up to 20, and the quality gate
   (Milestone 11) is where unsupported claims become blocking.

## ACCEPTANCE CRITERIA

| Criterion                                      | Evidence                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| One learning event produces one canonical atom | unique constraint + test asserting a single row after build                                                        |
| All later formats can reference the same atom  | atom is `ready` with a validated body; ideas and items carry `content_atom_id` (schema + FKs already in place)     |
| Raw learning provenance is preserved           | `raw_text` asserted unchanged after build; live psql shows event -> atom -> 5 sources                              |
| Schema validation blocks malformed atoms       | `E_ATOM_INCOMPLETE` and `E_ATOM_INVALID_CITATION` both tested, both leave the atom `failed` with the reason stored |

## RECOMMENDED NEXT MILESTONE

09 - Content ideation engine.
