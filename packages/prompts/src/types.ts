import type { z } from 'zod';

/**
 * A prompt is a pure function from input to messages, plus the schema its output must satisfy.
 * Purity makes prompts snapshot-testable, and the stored `id`/`version` make every generated row
 * traceable to the exact text that produced it.
 */
export interface PromptDefinition<TInput, TSchema extends z.ZodTypeAny> {
  id: string;
  version: string;
  description: string;
  /** The schema the model's JSON must satisfy; validation failure is a permanent error. */
  outputSchema: TSchema;
  build(input: TInput): { system: string; user: string };
}

export type PromptOutput<T> = T extends PromptDefinition<never, infer S> ? z.infer<S> : never;

/** Wraps text so the deterministic mock provider can recover it from the rendered prompt. */
export const note = (text: string): string => `<<<NOTE\n${text}\nNOTE>>>`;
