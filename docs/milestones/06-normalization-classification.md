# Milestone 06 - Learning normalization, classification and deduplication

**STATUS: COMPLETE**

**OBJECTIVE:** Turn raw learning notes into structured, searchable learning records.

## WHAT I BUILT

The first real pipeline stage: normalization that removes capture noise without touching words,
near-duplicate detection that links rather than deletes, LLM classification into a fixed taxonomy
with schema validation, and the Content Atom shell - plus the LLM adapter layer (mock / ollama /
failing) and the versioned prompt registry those stages depend on.

## TASKS COMPLETED

| #   | Atomic task                                                 | Result                                                                                                                  |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Allowed topic taxonomy                                      | 16 topics + 5 kinds in `enums.ts`, mirrored by SQL CHECKs, enforced in the prompt and by zod                            |
| 2   | Learning event status flow                                  | `received -> normalized -> classified -> atomized`, with `duplicate`/`failed` exits; transitions are monotonic          |
| 3   | Normalization step                                          | `normalizeNote`                                                                                                         |
| 4   | Strip noise while preserving meaning                        | zero-width chars, smart quotes, list markers, indentation, double spaces; a test asserts the word sequence is unchanged |
| 5   | Extract title when absent                                   | `deriveTitle` strips "Today I learned that"/"TIL:" and caps at 120 chars                                                |
| 6   | Classify primary topic                                      | `classify.v1`, restricted to the taxonomy                                                                               |
| 7   | Classify secondary topics                                   | up to 3                                                                                                                 |
| 8   | Identify DSA / core engineering / project / book / other    | `kind` field                                                                                                            |
| 9   | Extract technical entities                                  | up to 10, from the note only                                                                                            |
| 10  | Estimate content-worthiness without deciding publication    | advisory boolean + reason + confidence; nothing publishes automatically                                                 |
| 11  | Deterministic content hash                                  | `contentHash(canonicalizeText(text))`, computed at capture                                                              |
| 12  | Use the hash to detect duplicates                           | unique index rejects exact repeats at capture; near-duplicates detected in the pipeline                                 |
| 13  | Keep duplicate references rather than destroying provenance | duplicate keeps its own row and raw text, `duplicate_of` links to the original                                          |
| 14  | Create the Content Atom shell                               | one per event, `draft`, enforced by a unique constraint                                                                 |
| 15  | Fixtures for different note shapes                          | 6 note fixtures + a near-duplicate pair + a distinct same-topic note                                                    |
| 16  | Run the workflow repeatedly to verify idempotency           | reprocess, forced reprocess, and three concurrent runs all tested                                                       |

## FILES CREATED

`packages/adapters/src/llm/{types,json,mock,mock-knowledge,ollama,failing,index}.ts` + `llm.test.ts`;
`packages/prompts/src/{types,brand-voice,classify.v1,registry,index}.ts`;
`packages/core/src/{normalize,dedupe,process-learning}.ts` + three test files;
`packages/db/src/repositories/content-atoms.ts`;
`apps/api/src/routes/pipeline.ts`;
`tests/fixtures/learning-notes.ts`; `docs/pipeline.md`; `docs/external-apis.md`.

## FILES MODIFIED

`packages/schemas/src/content-atom.ts` (shell-vs-ready split), `packages/schemas/src/schemas.test.ts`,
`packages/db/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/capture.ts`,
`packages/adapters/src/index.ts`, `docs/milestones/README.md`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify         # 242 tests
# live: capture -> process -> reprocess -> near-duplicate -> distinct -> model-down
```

## TEST RESULTS

242 passed. New coverage: 11 normalization tests, 11 deduplication tests, 13 pipeline tests
(including the model-down and off-schema paths and three concurrent processings), 19 LLM adapter
tests (fake `fetch`: success, 400, 429, 500, timeout, empty completion, JSON-mode flag).

**Tuning corrected by live evidence.** The first similarity metric (word + bigram Jaccard,
threshold 0.35) passed its fixture but missed a real restatement during live verification, scoring
it 0.205. Rather than lowering the threshold blindly, I measured both metrics across every fixture
pair: adding a containment term separates the classes far better - same learning 0.31-0.56,
different learnings 0.00-0.07. Threshold is now 0.18, containment is ignored for short notes (to
avoid "contained in everything" false positives), the live case is a regression test, and a margin
test fails the build if future tuning narrows the gap.

## MANUAL VERIFICATION

```
$ curl -X POST .../capture -d '{"text":"Today I learned that Redis SETNX locks are not a queue..."}'
$ curl -X POST .../learning-events/le_.../process
{"status":"atomized","duplicate_of":null,"duplicate_score":0.211,
 "classification":{"kind":"core_engineering","primary_topic":"backend","entities":["Redis"],
                   "content_worthy":true,"confidence":0.72},
 "content_atom_id":"ca_...","atom_created":true}

$ # same call again
{"status":"atomized","unchanged":true,"content_atom_id":"ca_...(same)","atom_created":false}

$ # the same learning, reworded
{"status":"duplicate","duplicate_of":"le_0mubptws...","duplicate_score":0.31,"content_atom_id":null}

$ # a genuinely different note
{"status":"atomized","duplicate_of":null,"duplicate_score":0}
$ psql -c "select count(*) from content_atoms"   -> 2   (not 3)

$ # LLM_PROVIDER=failing
http 503 {"error":{"code":"E_LLM_UNREACHABLE",...}}
psql -> event status: failed | classification null: true
psql -> error row: learning_process_v1 / classify / E_LLM_UNREACHABLE / transient
psql -> atoms for that event: 0
```

## SECURITY REVIEW

- The mock provider's heuristics live in `@sce/adapters` and are never imported by `@sce/core`, so
  a real provider failure can never be silently replaced by heuristics.
- Prompts embed the note between markers; no credentials or environment values are interpolated.
- Ollama responses are validated before use; provider error bodies are truncated to 200 chars in
  failure details and never logged wholesale.
- The pipeline endpoints sit behind the same bearer auth as capture.

## KNOWN LIMITATIONS

1. Classification quality with a real model is unverified - no Ollama instance exists here. The
   contract (taxonomy + schema validation) is enforced regardless of provider, and the adapter's
   HTTP behaviour is covered by fake-`fetch` tests.
2. Near-duplicate detection compares against the 200 most recent non-duplicate events. That is
   fine at personal scale; a growing corpus will need embeddings or a trigram index (noted for
   Milestone 17).
3. The atom shell is empty by design; it is filled by Milestones 07 (evidence) and 08 (canonical
   structure).
4. Processing is triggered explicitly (API or n8n). Automatic post-capture triggering arrives with
   the worker in a later milestone - deliberate, so a slow model never blocks capture.

## ACCEPTANCE CRITERIA

| Criterion                                 | Evidence                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Learning events become structured records | `normalized_text`, `title`, `classification` populated; verified live and in tests                  |
| Duplicates do not create duplicate atoms  | restated note -> `duplicate`, no atom; `select count(*) from content_atoms` returned 2 for 3 notes  |
| Classification is visible and editable    | stored as JSONB on the event, returned by the API, re-runnable with `force`                         |
| Original data remains available           | `raw_text` asserted unchanged after processing; duplicates keep their own row                       |
| Deterministic status transitions          | monotonic transition test; reprocessing reports `unchanged`; three concurrent runs produce one atom |

## RECOMMENDED NEXT MILESTONE

07 - Research and evidence enrichment.
