import type { AppFailure, Result } from './errors.js';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected in tests so retries do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic jitter source; defaults to crypto-free pseudo-jitter derived from the attempt. */
  jitter?: (attempt: number) => number;
  onRetry?: (info: { attempt: number; delayMs: number; failure: AppFailure }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic jitter in [0.5, 1.0) derived from the attempt number.
 * Full randomness is unnecessary for a single-tenant system and makes tests flaky.
 */
const defaultJitter = (attempt: number): number => 0.5 + ((attempt * 0.37) % 0.5);

export const backoffDelay = (
  attempt: number,
  { baseDelayMs = 250, maxDelayMs = 30_000, jitter = defaultJitter }: RetryOptions = {},
): number =>
  Math.min(maxDelayMs, Math.round(baseDelayMs * 2 ** (attempt - 1) * (1 + jitter(attempt))));

/**
 * Runs an operation that returns a Result, retrying only `transient` failures.
 * Permanent failures return immediately - retrying a validation error is waste, not resilience.
 */
export const withRetry = async <T>(
  operation: (attempt: number) => Promise<Result<T, AppFailure>>,
  options: RetryOptions = {},
): Promise<Result<T, AppFailure> & { attempts?: number }> => {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  let last: AppFailure | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await operation(attempt);
    if (result.ok) return { ...result, attempts: attempt };

    last = result.error;
    if (result.error.kind === 'permanent' || attempt === attempts) {
      return { ok: false, error: result.error, attempts: attempt };
    }

    const delayMs = Number(
      result.error.details?.['retryAfterMs'] ?? backoffDelay(attempt, options),
    );
    options.onRetry?.({ attempt, delayMs, failure: result.error });
    await sleep(delayMs);
  }

  /* c8 ignore next */
  return { ok: false, error: last!, attempts };
};
