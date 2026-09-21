import { z } from 'zod';

/** Shared primitives. Contract version is stored with payloads so consumers can migrate safely. */
export const CONTRACT_VERSION = 1;

export const idSchema = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 3)
    .regex(new RegExp(`^${prefix}_[0-9a-z]+$`), `must be a ${prefix}_ id`);

export const isoDateTime = z.string().datetime({ offset: true });

export const correlationId = z
  .string()
  .min(4)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'correlation id must be url-safe');

export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest');

/** URLs we are willing to store or fetch: http(s) only, no credentials embedded. */
export const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) url')
  .refine((u) => {
    try {
      const parsed = new URL(u);
      return parsed.username === '' && parsed.password === '';
    } catch {
      return false;
    }
  }, 'url must not embed credentials');

export const timestamps = z.object({
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

export type Timestamps = z.infer<typeof timestamps>;
