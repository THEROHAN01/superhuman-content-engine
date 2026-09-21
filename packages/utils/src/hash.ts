import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Canonical text form used for content hashing and duplicate detection.
 * Deliberately lossy (case, punctuation, whitespace) so trivially different captures of the same
 * thought collide, while the raw text is always preserved separately.
 */
export const canonicalizeText = (input: string): string =>
  input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_~>#|]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const sha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

/** Stable hash of meaning-bearing text. Same thought captured twice -> same hash. */
export const contentHash = (input: string): string => sha256(canonicalizeText(input));

/**
 * Deterministic key for any operation that can be replayed. Parts are joined with a separator
 * that cannot appear in an id, so ('a','bc') and ('ab','c') never collide.
 */
export const idempotencyKey = (...parts: readonly (string | number)[]): string =>
  sha256(parts.map((p) => String(p)).join('\u0000'));

/** Constant-time comparison for secrets (webhook signatures, bearer tokens). */
export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still compare to keep timing independent of which mismatch occurred.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};
