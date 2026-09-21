import type { AppFailure, Result } from '@sce/utils';

/**
 * The research boundary.
 *
 * A search that fails must never look like a search that found nothing, and a search that found
 * nothing must never look like evidence. Both are represented explicitly.
 */
export interface ResearchQuery {
  query: string;
  maxResults: number;
  correlationId?: string;
}

export interface ResearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Which engine produced it, when the provider aggregates several. */
  engine?: string;
  publishedAt?: string;
}

export interface ResearchAdapter {
  readonly name: string;
  /** True for providers whose results are synthetic and must not be cited as evidence. */
  readonly synthetic: boolean;
  search(query: ResearchQuery): Promise<Result<ResearchHit[], AppFailure>>;
}
