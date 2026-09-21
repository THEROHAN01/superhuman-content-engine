import { z } from 'zod';
import {
  CONTENT_ANGLES,
  CONTENT_ATOM_STATUSES,
  EVIDENCE_STATUSES,
  LEARNING_KINDS,
  TOPICS,
} from './enums.js';
import { idSchema, isoDateTime, timestamps } from './common.js';
import { claimSupport } from './source-document.js';

/**
 * Content Atom v1 - the canonical structured object every content format is derived from.
 * Optional sections are nullable rather than absent so a partially-known atom is still valid and
 * its gaps are visible.
 */
export const CONTENT_ATOM_SCHEMA_VERSION = 1;

export const contentAtomBody = z.object({
  /** The question or problem this learning answers. */
  problem: z.string().min(10).max(1000),
  /** The single most useful takeaway, in one or two sentences. */
  core_insight: z.string().min(10).max(1000),
  /** Explanation from first principles - why it works, not just what to do. */
  first_principles: z.string().min(10).max(4000),
  example: z.string().max(4000).nullable(),
  implementation_details: z.string().max(4000).nullable(),
  /** The failure mode or mistake this knowledge prevents. */
  failure_mode: z.string().max(2000).nullable(),
  mental_model: z.string().max(2000).nullable(),
  /** Rohan's own observation - the part that cannot be generated, only captured. */
  personal_observation: z.string().max(2000).nullable(),
  /** Factual claims that research must support. */
  claims: z.array(claimSupport).max(20).default([]),
  /** Candidate angles for later ideation; ideation may add more. */
  angle_candidates: z.array(z.enum(CONTENT_ANGLES)).max(8).default([]),
});
export type ContentAtomBody = z.infer<typeof contentAtomBody>;

export const contentAtom = z
  .object({
    id: idSchema('ca'),
    schema_version: z.literal(CONTENT_ATOM_SCHEMA_VERSION),
    learning_event_id: idSchema('le'),
    status: z.enum(CONTENT_ATOM_STATUSES),
    title: z.string().min(3).max(200),
    kind: z.enum(LEARNING_KINDS),
    primary_topic: z.enum(TOPICS),
    secondary_topics: z.array(z.enum(TOPICS)).max(3),
    entities: z.array(z.string()).max(20),
    body: contentAtomBody,
    evidence_status: z.enum(EVIDENCE_STATUSES),
    /** Confidence in the atom's factual content, not in its writing quality. */
    confidence: z.number().min(0).max(1),
    /** Error detail when status is `failed`; keeps failed transformations inspectable. */
    error: z.string().max(2000).nullable(),
    generator_version: z.string().max(60),
    atomized_at: isoDateTime.nullable(),
  })
  .merge(timestamps);
export type ContentAtom = z.infer<typeof contentAtom>;
