# Quality gate

`POST /content-items/:id/gate` decides whether a draft is fit to reach a human. It is
**deterministic** (same inputs, same verdict), **idempotent** (a replay returns the stored result
for the same gate version), and it **never edits the draft** - a gate that rewrote claims would
destroy the provenance the rest of the system maintains.

Version: `gate.v1`. Every result stores its gate version and evaluation timestamp, so old verdicts
stay interpretable after the rules change.

## Verdicts

| Verdict        | Meaning                          | Item status                                     |
| -------------- | -------------------------------- | ----------------------------------------------- |
| `pass`         | no blocks, fewer than 2 warnings | `gated` (ready for approval)                    |
| `needs_review` | no blocks, 2+ warnings           | `gated`, with the reasons shown to the approver |
| `reject`       | at least one block               | `rejected` (never reaches the approval queue)   |

The score (0-1) is a readable summary; the verdict comes from the reasons, not from a threshold on
the score.

## Checks

| Code                                          | Severity | What it catches                                                            |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `PLATFORM_*`                                  | block    | hard platform violations (unit too long, too few/many units, empty unit)   |
| `EVIDENCE_RESEARCH_FAILED`                    | block    | the idea needs evidence and research failed                                |
| `EVIDENCE_MISSING`                            | block    | the idea needs evidence and the atom has none                              |
| `EVIDENCE_WEAK`                               | warn     | evidence is partial or unreviewed; claims must read as observation         |
| `SYNTHETIC_EVIDENCE`                          | block    | every source came from the mock provider - it cannot support public claims |
| `UNSUPPORTED_CLAIM`                           | block    | the atom carries a claim marked unsupported                                |
| `CLAIM_NEEDS_REVIEW`                          | warn     | the atom carries unverified claims                                         |
| `UNTRACEABLE_URL`                             | block    | the draft links somewhere the system never retrieved                       |
| `ATTRIBUTION_UNKNOWN_SOURCE`                  | block    | attribution references a source not attached to the atom                   |
| `ATTRIBUTION_MISSING`                         | warn     | sources exist but the draft carries no attribution                         |
| `FABRICATED_EXPERIENCE`                       | block    | first-person experience the learning note never recorded                   |
| `GENERIC_LANGUAGE`                            | block    | more than one banned filler phrase                                         |
| `BANNED_PHRASE`                               | warn     | a single filler phrase                                                     |
| `HYPE`, `EXCESSIVE_PUNCTUATION`               | warn     | hype markers, more than two exclamation marks                              |
| `NO_MECHANISM`                                | warn     | states what, never why                                                     |
| `NOT_SPECIFIC`                                | warn     | no technology, number or concrete example                                  |
| `DUPLICATE_UNIT`                              | warn     | a thread or carousel that repeats itself                                   |
| `REPEATS_EXISTING_CONTENT`                    | block    | 50%+ similar to another live draft                                         |
| `TOO_SHORT`, `HOOK_TOO_LONG`, `HASHTAGS_ON_X` | warn     | editorial floors and platform habits                                       |

Rejected and superseded drafts are excluded from the repetition corpus: content that will never be
published cannot make new content "repetitive".

## Fixtures

`tests/fixtures/drafts.ts` is the executable definition of the gate's behavior: high quality,
hallucinated link, fabricated experience, unsupported claim, generic filler, overlong, evidence
failure, and thin-but-harmless. Each fixture names the verdict _and_ the reason code that must
appear, so a rule change that breaks one is visible immediately.

## Why deterministic rather than model-judged

An LLM judge would make verdicts unreproducible, unexplainable to the person approving the post,
and dependent on a service being up. Every check here is a rule over data the system already has,
so the same draft always gets the same answer and the reasons can be shown verbatim in the
approval card.
