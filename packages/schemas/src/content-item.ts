import { z } from 'zod';
import { CONTENT_FORMATS, CONTENT_ITEM_STATUSES, GATE_VERDICTS, PLATFORMS } from './enums.js';
import { httpUrl, idSchema, isoDateTime, timestamps } from './common.js';

/** One unit of a draft: a tweet in a thread, a carousel slide, a reel beat, or a whole post. */
export const contentUnit = z.object({
  index: z.number().int().min(0),
  text: z.string().min(1).max(4000),
  /** Slide/scene note: visual direction for carousels and reels. */
  note: z.string().max(500).nullable().default(null),
});
export type ContentUnit = z.infer<typeof contentUnit>;

export const contentDraft = z.object({
  hook: z.string().min(5).max(400),
  units: z.array(contentUnit).min(1).max(12),
  /** Rendered, publishable text. Derived from units, stored so publishing never re-renders. */
  body: z.string().min(1).max(20_000),
  hashtags: z.array(z.string().max(40)).max(8).default([]),
  call_to_action: z.string().max(300).nullable().default(null),
  /** Attribution lines for the evidence used, kept with the draft so it cannot be lost. */
  source_attributions: z
    .array(z.object({ source_id: idSchema('sd'), url: httpUrl, title: z.string().max(300) }))
    .max(10)
    .default([]),
});
export type ContentDraft = z.infer<typeof contentDraft>;

export const qualityGateResult = z.object({
  verdict: z.enum(GATE_VERDICTS),
  score: z.number().min(0).max(1),
  gate_version: z.string().max(60),
  /** Machine-readable reasons, e.g. {code:'GENERIC_LANGUAGE', severity:'warn', detail:'...'} */
  reasons: z
    .array(
      z.object({
        code: z.string().min(2).max(60),
        severity: z.enum(['info', 'warn', 'block']),
        detail: z.string().max(500),
      }),
    )
    .max(40),
  evaluated_at: isoDateTime,
});
export type QualityGateResult = z.infer<typeof qualityGateResult>;

export const contentItem = z
  .object({
    id: idSchema('it'),
    content_idea_id: idSchema('ci'),
    content_atom_id: idSchema('ca'),
    learning_event_id: idSchema('le'),
    /** Version within (idea, format); regeneration increments it and supersedes the previous one. */
    version: z.number().int().min(1),
    status: z.enum(CONTENT_ITEM_STATUSES),
    platform: z.enum(PLATFORMS),
    format: z.enum(CONTENT_FORMATS),
    draft: contentDraft,
    quality_gate: qualityGateResult.nullable(),
    prompt_id: z.string().max(60),
    prompt_version: z.string().max(60),
    model: z.string().max(80),
    /** Set when this version was replaced by a regeneration. */
    superseded_by: idSchema('it').nullable(),
    error: z.string().max(2000).nullable(),
    correlation_id: z.string(),
  })
  .merge(timestamps);
export type ContentItem = z.infer<typeof contentItem>;
