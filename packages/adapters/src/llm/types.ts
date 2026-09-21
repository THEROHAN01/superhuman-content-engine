import type { z } from 'zod';
import type { AppFailure, Result } from '@sce/utils';

/**
 * The LLM boundary.
 *
 * Callers never see provider payloads: they ask for a completion, optionally with a schema, and
 * receive a validated object or a typed failure. A model that returns unparseable output is a
 * `permanent` failure - retrying the same prompt would waste time and money.
 */
export interface LlmRequest {
  /** Prompt identity, e.g. `classify.v1`. The mock provider keys deterministic answers off it. */
  purpose: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  correlationId?: string;
  /** Request JSON-mode output where the provider supports it. */
  json?: boolean;
}

export interface LlmResponse {
  text: string;
  model: string;
  provider: string;
  durationMs: number;
}

export interface LlmAdapter {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<Result<LlmResponse, AppFailure>>;
}

export interface JsonCompletion<T> {
  value: T;
  model: string;
  provider: string;
}

export type LlmJsonResult<T> = Result<JsonCompletion<T>, AppFailure>;

export type SchemaOf<T> = z.ZodType<T>;
