# Milestone 11 - Automated content quality gate

**STATUS: COMPLETE**

**OBJECTIVE:** Keep weak, generic, or unsupported content out of the approval queue.

## WHAT I BUILT

A deterministic, versioned, idempotent gate: 19 checks over the draft, its idea, its atom, its
evidence and the existing corpus, producing a verdict plus machine-readable reasons that the
approval card can show verbatim. It records its judgement and never edits the content it judges.

## TASKS COMPLETED

| #   | Atomic task                                  | Result                                                                                                                                               |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Define quality dimensions                    | evidence, claim support, traceability, honesty, language, teaching value, specificity, repetition, platform fit                                      |
| 2   | Check factual-claim support                  | `UNSUPPORTED_CLAIM` (block), `CLAIM_NEEDS_REVIEW` (warn)                                                                                             |
| 3   | Check evidence presence when required        | `EVIDENCE_MISSING`, `EVIDENCE_RESEARCH_FAILED` (block), `EVIDENCE_WEAK` (warn)                                                                       |
| 4   | Check source traceability                    | `UNTRACEABLE_URL`, `ATTRIBUTION_UNKNOWN_SOURCE` (block), `ATTRIBUTION_MISSING` (warn)                                                                |
| 5   | Check generic AI language                    | `GENERIC_LANGUAGE` (block at 2+), `BANNED_PHRASE` (warn)                                                                                             |
| 6   | Check excessive hype/clickbait               | `HYPE`, `EXCESSIVE_PUNCTUATION`                                                                                                                      |
| 7   | Check repetition against existing content    | `REPEATS_EXISTING_CONTENT` at 50% similarity, excluding rejected and superseded drafts                                                               |
| 8   | Check platform constraints                   | `PLATFORM_*` from the shared validator                                                                                                               |
| 9   | Check whether the draft teaches something    | `NO_MECHANISM` when no causal explanation appears                                                                                                    |
| 10  | Check specificity and examples               | `NOT_SPECIFIC` when no technology, number or example appears                                                                                         |
| 11  | Check personal claims are genuinely personal | `FABRICATED_EXPERIENCE` (block)                                                                                                                      |
| 12  | Return PASS / NEEDS_REVIEW / REJECT          | blocks -> reject; 2+ warnings -> needs_review; otherwise pass                                                                                        |
| 13  | Machine-readable reasons                     | `{code, severity, detail}`; codes asserted to be stable identifiers                                                                                  |
| 14  | Do not silently alter claims                 | the gate only writes `quality_gate` and status; a test asserts the draft is byte-identical afterwards                                                |
| 15  | Fixtures                                     | 8 in `tests/fixtures/drafts.ts`: high quality, hallucinated link, fabricated experience, unsupported claim, generic, overlong, research-failed, thin |
| 16  | Idempotent gating                            | a stored result for the same gate version is returned unchanged; a replay does no work (asserted by counting workflow runs)                          |
| 17  | Store gate version and timestamp             | `gate_version` + `evaluated_at` on the stored result                                                                                                 |

## FILES CREATED

`packages/core/src/quality-gate.ts` + `quality-gate.test.ts`; `tests/fixtures/drafts.ts`;
`docs/quality-gate.md`.

## FILES MODIFIED

`packages/db/src/repositories/content-items.ts` (the gate may reject straight from `draft`),
`apps/api/src/routes/pipeline.ts`, `packages/core/src/index.ts`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify     # 358 tests
bash /tmp/live-gate.sh                # gate on mock-sourced content
bash /tmp/live-gate2.sh               # gate with research disabled
```

## TEST RESULTS

358 passed. Gate coverage: all 8 fixtures (verdict + required reason code), gate version and
timestamp storage, status transitions, idempotent replay doing no work, deterministic forced
re-evaluation reproducing the result exactly, draft left untouched, synthetic evidence blocked,
repetition blocked, rejected content excluded from the repetition corpus, reason shape, unknown
item.

Two test expectations were wrong and were corrected rather than the code weakened: the gate could
not reject a `draft` item (transition table fixed), and a "determinism" test compared two
identical drafts whose corpus differed - determinism means same _inputs_, and the corpus is an
input.

## MANUAL VERIFICATION

```
$ # default configuration: research provider is mock, so sources are synthetic
$ curl -X POST .../content-items/it_.../gate
verdict: reject | score: 0.6 | status: rejected | gate.v1
  [block] SYNTHETIC_EVIDENCE   every attached source is synthetic (mock provider)...

$ # replay
  verdict: reject | unchanged: True | reasons: 1
  workflow runs for gate: 1        # a replay does no work

$ # RESEARCH_PROVIDER=disabled, idea that does not require evidence
verdict: needs_review | score: 0.76 | status: gated
  [warn ] TOO_SHORT            307 characters total; below the 400 floor for linkedin_post
  [warn ] CLAIM_NEEDS_REVIEW   1 atom claim(s) are unverified
```

The first result is the safety property working as designed: with the default mock research
provider, nothing can pass the gate on synthetic evidence.

## SECURITY REVIEW

- The gate is pure computation over stored data - no outbound calls, no model dependency, so it
  cannot be degraded by a provider outage.
- URL checks canonicalize before comparing, so a tracking-parameter or scheme variation cannot
  smuggle an untraceable link past the traceability check.
- Blocks on fabricated experience and synthetic evidence are the last automated defence before a
  human sees the content; both are covered by fixtures.

## KNOWN LIMITATIONS

1. No model-based editorial judgement. That is deliberate (see `docs/quality-gate.md`): verdicts
   must be reproducible and explainable. A model-assisted advisory score could be added later as a
   separate, clearly-labelled reason.
2. `NO_MECHANISM` and `NOT_SPECIFIC` are heuristics over markers; they catch obviously thin drafts
   but will not judge whether an explanation is _correct_. That is what the human approval step is
   for.
3. The repetition check compares against the 200 most recent live drafts - fine at personal scale,
   and the same scaling note as near-duplicate learning detection.
4. Warning severity is uniform; some warnings (below length floor) matter less than others
   (weak evidence). Weighting them is a tuning question best answered with real approval data.

## ACCEPTANCE CRITERIA

| Criterion                                 | Evidence                                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Known bad fixtures are correctly flagged  | hallucinated link, fabricated experience, unsupported claim, generic, overlong and research-failed fixtures all reject with the expected code |
| Known good fixtures can pass              | the high-quality fixture passes; the thin-but-harmless one is `needs_review`, not rejected                                                    |
| Reasons are visible to the approval layer | reasons are stored on the item and returned by the endpoint with code, severity and detail                                                    |
| Quality-gate version is stored            | `gate_version` + `evaluated_at` on every stored result, asserted by test and visible in the live output                                       |

## RECOMMENDED NEXT MILESTONE

12 - Human approval with Telegram.
