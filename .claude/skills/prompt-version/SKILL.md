---
name: prompt-version
description: Create or change a versioned LLM prompt in packages/prompts (brand voice, ideation, platform generators, quality gate) while preserving provenance. Use whenever prompt text, brand voice rules, or banned phrases change.
---

# Versioned prompt changes

Every generated row stores the prompt id **and** version that produced it. That makes outputs
auditable and comparable, so prompts are append-only.

## Rules

1. Shipped prompt versions are immutable. To change behavior, add
   `packages/prompts/src/<name>.v<N+1>.ts` and register it in `packages/prompts/src/registry.ts`.
2. Export `{ id, version, build(input): {system, user}, outputSchema }`. `build` must be a pure
   function — no clock, no randomness, no I/O — so it can be snapshot-tested.
3. Brand voice (`brand-voice.ts`), approved examples (`examples.ts`) and banned phrases
   (`banned-phrases.ts`) are shared inputs, not copies inside each prompt.
4. Platform constraints (length, thread size, carousel slides) live in
   `packages/schemas/src/platform-constraints.ts` — never hard-coded inside prompt text.
5. The prompt must instruct the model to return JSON matching `outputSchema`; the caller
   validates with zod and treats a validation failure as a `permanent` generation failure that is
   stored with an error state, never silently dropped.
6. Add/refresh a snapshot test: `pnpm test -- packages/prompts`. Snapshots make prompt drift
   visible in review.

## Checklist before committing

- [ ] New version file added, old version untouched
- [ ] Registry updated, default version bumped only intentionally
- [ ] Snapshot tests updated and reviewed (the diff is the point)
- [ ] `docs/prompts.md` row added (id, version, purpose, inputs, output schema, changed-why)
