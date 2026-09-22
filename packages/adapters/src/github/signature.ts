import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * GitHub webhook signature verification.
 *
 * GitHub signs the **raw** request body with the shared secret and sends
 * `X-Hub-Signature-256: sha256=<hex>`. Verification must therefore run against the exact bytes
 * received - re-serializing the parsed JSON would change whitespace and break the signature (and,
 * worse, would let a crafted payload that re-serializes identically pass).
 */
export interface SignatureCheck {
  valid: boolean;
  reason?: 'missing' | 'malformed' | 'mismatch';
}

export const verifyGithubSignature = (
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): SignatureCheck => {
  if (!signatureHeader) return { valid: false, reason: 'missing' };

  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) return { valid: false, reason: 'malformed' };

  const expected = createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest();
  const provided = Buffer.from(match[1]!, 'hex');

  if (expected.length !== provided.length) return { valid: false, reason: 'mismatch' };
  return timingSafeEqual(expected, provided)
    ? { valid: true }
    : { valid: false, reason: 'mismatch' };
};

/** Test helper and operator convenience: produces the header GitHub would send. */
export const signGithubPayload = (rawBody: Buffer | string, secret: string): string =>
  `sha256=${createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex')}`;
