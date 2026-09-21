import { z } from 'zod';
import { CONTENT_ANGLES, CONTENT_FORMATS, CONTENT_IDEA_STATUSES, PLATFORMS } from './enums.js';
import { idSchema, sha256Hex, timestamps } from './common.js';

/** One distinct content opportunity derived from an atom. */
export const contentIdeaDraft = z.object({
  angle: z.enum(CONTENT_ANGLES),
  title: z.string().min(5).max(160),
  /** Why this is worth someone's attention - forces the generator to justify the idea. */
  rationale: z.string().min(10).max(1000),
  audience: z.string().min(3).max(200),
  platforms: z.array(z.enum(PLATFORMS)).min(1).max(3),
  formats: z.array(z.enum(CONTENT_FORMATS)).min(1).max(5),
  hook: z.string().min(5).max(280),
  /** Whether this angle needs external evidence before it can be generated. */
  evidence_required: z.boolean(),
});
export type ContentIdeaDraft = z.infer<typeof contentIdeaDraft>;

export const contentIdea = contentIdeaDraft
  .extend({
    id: idSchema('ci'),
    content_atom_id: idSchema('ca'),
    learning_event_id: idSchema('le'),
    status: z.enum(CONTENT_IDEA_STATUSES),
    /** Hash of the canonicalized title+hook; the unique key that stops idea sprawl. */
    dedupe_hash: sha256Hex,
    rejection_reason: z.string().max(500).nullable(),
    score: z.number().min(0).max(1).nullable(),
    prompt_version: z.string().max(60),
  })
  .merge(timestamps);
export type ContentIdea = z.infer<typeof contentIdea>;
