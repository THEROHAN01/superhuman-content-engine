import { z } from 'zod';
import { PLATFORMS, PUBLICATION_STATUSES } from './enums.js';
import { httpUrl, idSchema, isoDateTime, sha256Hex, timestamps } from './common.js';

/** The record of an attempt to schedule or publish an approved item through a provider. */
export const publication = z
  .object({
    id: idSchema('pb'),
    content_item_id: idSchema('it'),
    learning_event_id: idSchema('le'),
    platform: z.enum(PLATFORMS),
    status: z.enum(PUBLICATION_STATUSES),
    /** Deterministic from (item, platform, scheduled_at): the duplicate-publication guard. */
    idempotency_key: sha256Hex,
    provider: z.string().min(1).max(40),
    /** Provider-side id; present once the provider has accepted the post. */
    external_id: z.string().max(200).nullable(),
    external_url: httpUrl.nullable(),
    scheduled_at: isoDateTime,
    published_at: isoDateTime.nullable(),
    /** Whether the send was simulated. Dry runs never count as published content. */
    dry_run: z.boolean(),
    attempts: z.number().int().min(0),
    last_error: z.string().max(2000).nullable(),
    /** Provider response metadata, with credentials stripped before storage. */
    provider_metadata: z.record(z.unknown()).nullable(),
    correlation_id: z.string(),
  })
  .merge(timestamps);
export type Publication = z.infer<typeof publication>;

export const schedulePublicationRequest = z.object({
  content_item_id: idSchema('it'),
  scheduled_at: isoDateTime,
  correlation_id: z.string().optional(),
});
export type SchedulePublicationRequest = z.infer<typeof schedulePublicationRequest>;
