import { z } from 'zod';
import { SOURCE_TYPES } from './enums.js';
import { httpUrl, idSchema, isoDateTime, timestamps } from './common.js';

/** A piece of evidence attached to a learning event or atom. */
export const sourceDocument = z
  .object({
    id: idSchema('sd'),
    learning_event_id: idSchema('le').nullable(),
    content_atom_id: idSchema('ca').nullable(),
    title: z.string().min(1).max(500),
    url: httpUrl,
    /** Canonical form used for deduplication: lowercased host, no tracking params, no fragment. */
    canonical_url: httpUrl,
    source_type: z.enum(SOURCE_TYPES),
    /** Verbatim excerpt supporting the claim. Never paraphrased by the retrieval step. */
    excerpt: z.string().max(4000).nullable(),
    summary: z.string().max(2000).nullable(),
    retrieved_at: isoDateTime,
    /** Which search provider produced it - `mock` results are never presented as real evidence. */
    provider: z.string().min(1).max(40),
    relevance: z.number().min(0).max(1).nullable(),
  })
  .merge(timestamps);
export type SourceDocument = z.infer<typeof sourceDocument>;

export const claimSupport = z.object({
  claim: z.string().min(3).max(1000),
  status: z.enum(['supported', 'unsupported', 'needs_review']),
  source_ids: z.array(idSchema('sd')).default([]),
  note: z.string().max(500).optional(),
});
export type ClaimSupport = z.infer<typeof claimSupport>;
