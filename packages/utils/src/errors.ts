/** Typed failures shared by every layer. Nothing throws bare strings or `Error` across a boundary. */

export type FailureKind =
  /** Retrying later may succeed: network blips, 5xx, 429, timeouts. */
  | 'transient'
  /** Retrying will never succeed: validation, 4xx, schema violations. */
  | 'permanent';

export type Result<T, E = AppFailure> = { ok: true; value: T } | { ok: false; error: E };

export interface AppFailure {
  kind: FailureKind;
  code: string;
  message: string;
  /** Safe-to-log context. Never put credentials or raw provider payloads here. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E = AppFailure>(error: E): Result<never, E> => ({ ok: false, error });

export const transient = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): AppFailure => ({ kind: 'transient', code, message, details, cause });

export const permanent = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): AppFailure => ({ kind: 'permanent', code, message, details, cause });

/** Thrown only at the outermost layer (HTTP handler / job runner), which converts it to a response. */
export class AppError extends Error {
  readonly kind: FailureKind;
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(failure: AppFailure, statusCode = failure.kind === 'permanent' ? 400 : 503) {
    super(failure.message, { cause: failure.cause });
    this.name = 'AppError';
    this.kind = failure.kind;
    this.code = failure.code;
    this.statusCode = statusCode;
    this.details = failure.details;
  }

  static permanent(
    code: string,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>,
  ) {
    return new AppError(permanent(code, message, details), statusCode);
  }

  static transient(
    code: string,
    message: string,
    statusCode = 503,
    details?: Record<string, unknown>,
  ) {
    return new AppError(transient(code, message, details), statusCode);
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/** Extracts a message without leaking a whole error object (which may carry headers) into logs. */
export const describeError = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  return 'unknown error';
};
