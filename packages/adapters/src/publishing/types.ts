import type { AppFailure, Result } from '@sce/utils';
import type { Platform } from '@sce/schemas';

/**
 * The publishing boundary.
 *
 * Deliberately narrow: schedule a post, cancel it, ask about it. Everything the system needs to
 * know afterwards - the provider's id for the post - comes back from `schedule`, because without
 * it a retry cannot tell "already published" from "never sent".
 */
export interface PublishPayload {
  /** Deterministic; the provider is asked to treat a repeat as the same request. */
  idempotencyKey: string;
  platform: Platform;
  /** The publishable text, rendered at generation time and never re-rendered here. */
  body: string;
  /** Thread posts or carousel slides, in order, when the platform supports them. */
  units: string[];
  scheduledAt: string;
  /** Free-form provider hints (channel id, media ids). Never credentials. */
  options?: Record<string, unknown>;
  correlationId?: string;
}

export interface PublishReceipt {
  externalId: string;
  externalUrl: string | null;
  status: 'scheduled' | 'published';
  /** Provider response metadata, already stripped of anything secret. */
  metadata: Record<string, unknown>;
}

export interface PublishingAdapter {
  readonly name: string;
  /** True when this adapter cannot reach a real platform; used to enforce dry-run semantics. */
  readonly simulated: boolean;
  schedule(payload: PublishPayload): Promise<Result<PublishReceipt, AppFailure>>;
  cancel(externalId: string): Promise<Result<void, AppFailure>>;
}
