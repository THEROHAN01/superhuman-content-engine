/** Time helpers. Every timestamp crossing a boundary is an ISO-8601 string in UTC. */

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Fixed clock for deterministic tests. */
export const fixedClock = (iso: string): Clock => {
  const at = new Date(iso);
  return () => new Date(at);
};

export const toIso = (d: Date): string => d.toISOString();

export const addMs = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Start of the ISO week (Monday 00:00) containing `at`, in the given IANA timezone.
 * Weekly reports are reproducible only if this boundary is deterministic.
 */
export const startOfIsoWeek = (at: Date, timeZone: string): Date => {
  const local = new Date(at.toLocaleString('en-US', { timeZone }));
  const offsetMs = at.getTime() - local.getTime();
  const dayOfWeek = (local.getDay() + 6) % 7; // Monday = 0
  local.setHours(0, 0, 0, 0);
  local.setDate(local.getDate() - dayOfWeek);
  return new Date(local.getTime() + offsetMs);
};
