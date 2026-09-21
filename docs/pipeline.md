# Learning pipeline

What happens between "Rohan writes a note" and "there is a Content Atom".

```
POST /capture                      -> learning_events (status: received, raw text verbatim)
POST /learning-events/:id/process  -> normalize -> deduplicate -> classify -> atom shell
POST /pipeline/process-pending     -> the same, for every event still `received`
```

## Stages

### 1. Normalize (`packages/core/src/normalize.ts`)

Removes capture noise only: zero-width characters, smart quotes and dashes, list markers,
indentation, double spaces, excess blank lines. Fenced code blocks keep their indentation.
Words are never changed, reordered, or removed - a test asserts the word sequence is identical
before and after. The raw text stays in `raw_text` regardless; normalization writes
`normalized_text`.

A title is derived when the capture had none, by stripping "Today I learned that" / "TIL:"
scaffolding from the first sentence and capping at 120 characters.

### 2. Deduplicate (`packages/core/src/dedupe.ts`)

Exact duplicates never reach this stage - the unique content hash rejects them at capture. This
stage catches the same learning _reworded_, using a blend of content-word Jaccard, containment and
word-bigram Jaccard over the canonicalized text, compared against recent non-duplicate events.

Measured separation on the fixtures: two wordings of one learning score 0.31-0.56; different
learnings score 0.00-0.07. The threshold is 0.18, and a test asserts the margin so retuning cannot
quietly erode it.

A duplicate is **linked, not deleted**: the new event keeps its own row and raw text, its status
becomes `duplicate`, and `duplicate_of` points at the original. No second atom is created.

### 3. Classify (`packages/prompts/src/classify.v1.ts`)

The model chooses `kind`, `primary_topic`, up to three `secondary_topics`, `entities`, and an
advisory `content_worthy` judgement with a stated reason and confidence. Topics and kinds are
restricted to the declared taxonomy and validated with zod; an off-taxonomy answer is a permanent
failure.

**Failure is never success.** If the model is unreachable or returns something off-schema, the
event moves to `failed`, an `error_events` row is written, and `classification` stays null. It is
re-runnable with `{"force": true}` once the model is back.

### 4. Atom shell

A qualifying event gets exactly one Content Atom (`content_atoms_learning_event_key`), created in
`draft` status with an empty body. Milestones 07 and 08 fill in evidence and the canonical
structure; the shell exists so classification, ideas and evidence all have something stable to
attach to.

## Idempotency

| Replay                                    | Result                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Same note captured twice                  | one event; the second call returns the original id with `duplicate: true` |
| `process` called twice                    | second call reports `unchanged: true` and performs no model call          |
| `process` called concurrently three times | one atom (database unique constraint), asserted by a test                 |
| `process --force` after success           | same atom reused, `atom_created: false`                                   |
| `process` after a model failure           | re-runs cleanly once the model is back                                    |

Status transitions are monotonic: `received -> normalized -> classified -> atomized`, with
`duplicate` and `failed` as side exits. A late replay cannot pull an event backwards.

## Taxonomy

Kinds: `dsa`, `core_engineering`, `project_work`, `book_research`, `other`.

Topics: `algorithms`, `system_design`, `backend`, `databases`, `distributed_systems`,
`networking`, `security`, `performance`, `devops`, `observability`, `ai_ml`, `frontend`,
`testing`, `career`, `product`, `other`.

Both lists live in `packages/schemas/src/enums.ts` and are mirrored by SQL CHECK constraints, with
an enum-parity test binding the two together.
