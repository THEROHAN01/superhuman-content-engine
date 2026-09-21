# Milestone 10 - Platform-specific content generators

**STATUS: COMPLETE**

**OBJECTIVE:** Convert one approved content idea into native formats for X, LinkedIn, Reel and
Carousel.

## WHAT I BUILT

Five generators that share one voice and one set of evidence rules but produce structurally
different output, with versioned immutable drafts, platform-limit validation that blocks storage,
editorial warnings that do not, and regeneration that supersedes rather than overwrites.

## TASKS COMPLETED

| #   | Atomic task                                     | Result                                                                              |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Brand voice rules file                          | `packages/prompts/src/brand-voice.ts`                                               |
| 2   | Examples file with approved samples             | `examples.ts`, one per format, each explaining _why_ it is a good sample            |
| 3   | Banned-phrases file                             | `banned-phrases.ts`, consumed by prompts and by validation                          |
| 4   | Platform constraints separate from prompts      | `platform-constraints.ts`; a test asserts each prompt states limits from that table |
| 5   | X short-post prompt                             | `x-post.v1`                                                                         |
| 6   | X thread prompt                                 | `x-thread.v1`                                                                       |
| 7   | LinkedIn post prompt                            | `linkedin-post.v1`                                                                  |
| 8   | Reel script prompt                              | `reel-script.v1`                                                                    |
| 9   | Carousel prompt                                 | `carousel.v1`                                                                       |
| 10  | Hook generated separately where helpful         | `hook.v1`                                                                           |
| 11  | Preserve factual claims and evidence references | prompts pass the atom body and sources; the draft carries `source_attributions`     |
| 12  | Source attribution fields                       | `draft.source_attributions[]` (source id, url, title), tested                       |
| 13  | Versioned content item                          | `(content_idea_id, format, version)` unique; version computed in a transaction      |
| 14  | Store generator prompt version                  | `prompt_id`, `prompt_version`, `model` on every row                                 |
| 15  | Store parent content idea id                    | plus atom id and learning event id                                                  |
| 16  | Validate output schema                          | zod on the model output, then `contentDraft` on the assembled draft                 |
| 17  | Validate platform constraints                   | hard errors block storage; `E_DRAFT_INVALID` with the specific violations           |
| 18  | Regeneration path                               | `{"regenerate": true}` creates version N+1 and supersedes N                         |
| 19  | Deterministic fixture tests                     | the mock provider produces the same draft for the same atom every time              |
| 20  | Confirm formats are genuinely platform-native   | asserted structurally and textually (below)                                         |

## FILES CREATED

`packages/prompts/src/{banned-phrases,examples,generate.v1}.ts` + `prompts.test.ts`;
`packages/adapters/src/llm/mock-generators.ts`;
`packages/core/src/{draft-validation,generate}.ts` + `generate.test.ts`;
`packages/db/src/repositories/content-items.ts`; `docs/prompts.md`.

## FILES MODIFIED

`packages/prompts/src/{brand-voice,registry,index}.ts`, `packages/adapters/src/llm/mock.ts`,
`packages/db/src/index.ts`, `packages/core/src/index.ts`, `apps/api/src/routes/pipeline.ts`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify     # 340 tests
bash /tmp/live-gen.sh                 # all five formats, then regeneration
```

## TEST RESULTS

340 passed. Generation coverage: all five formats with provenance and prompt version, structural
distinctness, platform limits, source attribution, skip-unless-regenerate, versioning with history
preserved, over-long unit rejected, too-short thread rejected, banned-phrase and hashtag warnings
that do not block, partial failure isolation, model-unreachable with nothing stored, idea marked
used, unknown idea. Plus 13 prompt tests (registry integrity, purity, limits sourced from the
constraint table, distinct instructions, shared voice/evidence rules, banned-phrase detection
without false positives).

**Live verification caught a real defect:** the generated thread contained the same post twice,
because two different sentences truncated to the same prefix. Drafts are now checked for repeated
units (an editorial warning, since the gate should decide severity), and the mock's beat builder
clamps _before_ deduplicating. Both are covered by tests.

## MANUAL VERIFICATION

```
$ curl -X POST .../content-ideas/ci_.../generate -d '{"formats":[all five]}'
  x_post         v1 units= 1 chars=  276 warnings=[]
  x_thread       v1 units= 3 chars=  444 warnings=[]
  linkedin_post  v1 units= 1 chars=  493 warnings=[]
  reel_script    v1 units= 3 chars=  437 warnings=[]
  carousel       v1 units= 5 chars=  622 warnings=[]
  failures: [] | skipped: []

$ # thread body is numbered at render time, each post distinct
1/ Mistake I made: I used Redis SETNX locks as a job queue.
2/ Locks expire, so when a worker pauses longer than the TTL two workers believe...
3/ A queue needs durable state and an explicit claim with a visibility timeout...

$ curl -X POST .../generate -d '{"formats":["x_post"],"regenerate":true}'
  version 2 supersedes it_0mubqqcmcf26863fcad994860
$ psql -> items: 6, superseded: 1
```

## SECURITY REVIEW

- Generators receive only stored atom content and source metadata; no credentials or environment
  values are interpolated into prompts.
- Model output is schema-validated and length-bounded before any database write.
- Source attributions reference stored source ids, so a draft cannot cite a URL the system never
  retrieved.
- Drafts are created as `draft` status only - generation cannot move content towards publishing.

## KNOWN LIMITATIONS

1. With the mock provider the drafts are extractive: sentences come from the atom rather than being
   rewritten for each platform. Structural nativeness is real and tested; _prose_ quality per
   platform is unverified until a real model runs.
2. `hook.v1` exists and is registered but is not yet wired into the generation flow - the
   format prompts currently generate their own hook. Wiring it in is a prompt-version change, not a
   schema change.
3. Editorial warnings are returned and stored with the generation result but are not yet acted on;
   that is the quality gate's job (Milestone 11).

## ACCEPTANCE CRITERIA

| Criterion                                  | Evidence                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All target formats can be generated        | live run produced all five with zero failures                                                                                                                                                          |
| Outputs have provenance and prompt version | every item carries idea/atom/event ids, `prompt_id`, `prompt_version`, `model`; asserted per item                                                                                                      |
| Formats are not copy/paste variants        | unit counts differ (1 / 3+ / 1 / 3+ / 5+), reel beats are time-coded, carousel slides carry visual notes, LinkedIn is longer than X, and rendered bodies are not near-identical (similarity assertion) |
| Malformed outputs fail validation          | over-long unit and under-length thread both rejected with specific codes, nothing stored, error rows written                                                                                           |

## RECOMMENDED NEXT MILESTONE

11 - Automated content quality gate.
