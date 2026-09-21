# Prompt catalog

Prompts are **pure functions** from input to messages, plus the schema their output must satisfy.
Every generated row stores the prompt id and version that produced it, so any draft can be traced
to the exact instructions behind it.

| Version            | Purpose                       | Input                                | Output schema                      | Notes                                                                                     |
| ------------------ | ----------------------------- | ------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `classify.v1`      | classify a learning note      | note text, optional title            | `learningEventClassification`      | taxonomy-constrained; content-worthiness is advisory only                                 |
| `atom.v1`          | build the canonical atom body | note, topic, kind, entities, sources | `contentAtomBody`                  | forbids inventing facts, sources and personal experience; unsupported fields must be null |
| `ideation.v1`      | propose content angles        | atom body + already-proposed titles  | `{ideas: contentIdeaDraft[]}`      | one idea per angle; each must state what it adds                                          |
| `x-post.v1`        | single X post                 | idea + atom + sources                | draft (hook, units, hashtags, CTA) | 1 unit, 280 chars                                                                         |
| `x-thread.v1`      | X thread                      | "                                    | "                                  | 3-12 units, 280 chars each, first unit stands alone                                       |
| `linkedin-post.v1` | LinkedIn post                 | "                                    | "                                  | 1 unit, 3000 chars, paragraph structure                                                   |
| `reel-script.v1`   | reel script                   | "                                    | "                                  | time-coded beats, on-screen notes                                                         |
| `carousel.v1`      | carousel                      | "                                    | "                                  | 5-10 slides, one idea each, visual note per slide                                         |
| `hook.v1`          | candidate opening lines       | atom + idea + format                 | `{hooks: string[]}`                | used when the opening carries most of the weight                                          |

## Shared inputs

- `brand-voice.ts` - the voice rules, identical across every format.
- `banned-phrases.ts` - reliable "generated text" tells. Consumed twice: as an instruction in the
  prompts and as a check in validation/quality gate. A phrase belongs here only if banning it
  cannot suppress ordinary technical writing (asserted by a test).
- `examples.ts` - approved writing samples per format. Style references, never content to reuse.
- Platform limits come from `packages/schemas/src/platform-constraints.ts`, never from prompt
  prose, so generation and validation cannot disagree. A test asserts each prompt states the
  limits from that table.

## Changing a prompt

Shipped versions are immutable. To change behavior, add `<name>.v<N+1>.ts`, register it, and bump
the default deliberately (see `.claude/skills/prompt-version`). The version stored on existing rows
keeps their provenance intact.

## Validation split

| Class                       | Examples                                                                           | Consequence                                          |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **errors** (platform facts) | unit too long, too few/many units, empty unit                                      | generation refuses to store the draft                |
| **warnings** (editorial)    | below the length floor, banned phrase, hashtags on X, hook too long, repeated unit | stored with the draft and handed to the quality gate |

That split keeps "the platform will reject this" separate from "an editor would push back on this".
