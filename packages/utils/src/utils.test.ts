import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  canonicalizeText,
  contentHash,
  EnvError,
  fixedClock,
  idempotencyKey,
  isId,
  newId,
  parseEnv,
  permanent,
  safeEqual,
  startOfIsoWeek,
  transient,
  withRetry,
} from './index.js';

describe('ids', () => {
  it('produces prefixed, time-ordered ids', () => {
    const early = newId('learningEvent', 1_700_000_000_000);
    const late = newId('learningEvent', 1_700_000_001_000);
    expect(early.startsWith('le_')).toBe(true);
    expect(early < late).toBe(true);
    expect(isId('learningEvent', early)).toBe(true);
    expect(isId('contentAtom', early)).toBe(false);
  });

  it('never collides across a large batch', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId('contentItem')));
    expect(ids.size).toBe(5000);
  });
});

describe('content hashing', () => {
  it('canonicalizes away formatting noise but keeps meaning', () => {
    expect(canonicalizeText('  **Refresh-token** rotation MATTERS!  ')).toBe(
      'refresh token rotation matters',
    );
  });

  it('gives the same hash to the same thought captured differently', () => {
    expect(contentHash('Why refresh token rotation matters')).toBe(
      contentHash('  why REFRESH-TOKEN rotation matters!! '),
    );
  });

  it('gives different hashes to different thoughts', () => {
    expect(contentHash('redis persistence')).not.toBe(contentHash('postgres persistence'));
  });

  it('ignores URLs so the same note with a link still deduplicates', () => {
    expect(contentHash('jwt rotation https://example.com/a')).toBe(contentHash('jwt rotation'));
  });
});

describe('idempotencyKey', () => {
  it('is deterministic and order sensitive', () => {
    expect(idempotencyKey('it_1', 'x', 5)).toBe(idempotencyKey('it_1', 'x', 5));
    expect(idempotencyKey('it_1', 'x')).not.toBe(idempotencyKey('x', 'it_1'));
  });

  it('cannot be confused by concatenation boundaries', () => {
    expect(idempotencyKey('a', 'bc')).not.toBe(idempotencyKey('ab', 'c'));
  });
});

describe('safeEqual', () => {
  it('compares secrets without leaking length through early return semantics', () => {
    expect(safeEqual('supersecrettoken', 'supersecrettoken')).toBe(true);
    expect(safeEqual('supersecrettoken', 'supersecrettokeN')).toBe(false);
    expect(safeEqual('short', 'longer-value')).toBe(false);
  });
});

describe('startOfIsoWeek', () => {
  it('returns Monday 00:00 local time for the containing week', () => {
    // 2026-09-21 is a Monday; 2026-09-24 is the Thursday of the same week.
    const monday = startOfIsoWeek(new Date('2026-09-24T09:30:00Z'), 'UTC');
    expect(monday.toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('is stable when called with any day of the same week', () => {
    const days = ['2026-09-21T23:00:00Z', '2026-09-23T05:00:00Z', '2026-09-27T18:00:00Z'];
    const starts = days.map((d) => startOfIsoWeek(new Date(d), 'UTC').toISOString());
    expect(new Set(starts).size).toBe(1);
  });
});

describe('retry', () => {
  it('retries transient failures and returns the eventual success', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return calls < 3
          ? { ok: false as const, error: transient('E_NET', 'boom') }
          : { ok: true as const, value: 'done' };
      },
      { attempts: 5, sleep },
    );
    expect(result).toMatchObject({ ok: true, value: 'done', attempts: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never retries a permanent failure', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return { ok: false as const, error: permanent('E_VALIDATION', 'bad input') };
      },
      { attempts: 5, sleep },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops after the attempt budget and reports the last failure', async () => {
    const result = await withRetry(
      async () => ({ ok: false as const, error: transient('E_NET', 'still down') }),
      { attempts: 3, sleep: async () => {} },
    );
    expect(result).toMatchObject({ ok: false, attempts: 3 });
    expect(result.ok === false && result.error.code).toBe('E_NET');
  });

  it('honours a provider-supplied retry delay', async () => {
    const delays: number[] = [];
    await withRetry(
      async (attempt) =>
        attempt === 1
          ? { ok: false as const, error: transient('E_RATE', '429', { retryAfterMs: 4321 }) }
          : { ok: true as const, value: 1 },
      { attempts: 2, sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([4321]);
  });

  it('grows the backoff delay and caps it', () => {
    const d1 = backoffDelay(1, { baseDelayMs: 100 });
    const d3 = backoffDelay(3, { baseDelayMs: 100 });
    expect(d3).toBeGreaterThan(d1);
    expect(backoffDelay(20, { baseDelayMs: 100, maxDelayMs: 5000 })).toBe(5000);
  });
});

describe('env validation', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/sce' };

  it('applies safe defaults', () => {
    const env = parseEnv(base as NodeJS.ProcessEnv);
    expect(env.PUBLISH_MODE).toBe('dry_run');
    expect(env.LLM_PROVIDER).toBe('mock');
    expect(env.API_BIND).toBe('127.0.0.1');
  });

  it('rejects a missing database url', () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv)).toThrow(EnvError);
  });

  it('refuses live publishing without a real publishing provider', () => {
    expect(() =>
      parseEnv({ ...base, PUBLISH_MODE: 'live', PUBLISHING_PROVIDER: 'mock' } as NodeJS.ProcessEnv),
    ).toThrow(/live publishing requires/);
  });

  it('requires credentials when a real provider is selected', () => {
    expect(() => parseEnv({ ...base, TELEGRAM_PROVIDER: 'telegram' } as NodeJS.ProcessEnv)).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
    expect(() => parseEnv({ ...base, PUBLISHING_PROVIDER: 'postiz' } as NodeJS.ProcessEnv)).toThrow(
      /POSTIZ_/,
    );
  });

  it('requires a capture token when bound beyond loopback', () => {
    expect(() => parseEnv({ ...base, API_BIND: '0.0.0.0' } as NodeJS.ProcessEnv)).toThrow(
      /CAPTURE_API_TOKEN/,
    );
    expect(() =>
      parseEnv({
        ...base,
        API_BIND: '0.0.0.0',
        CAPTURE_API_TOKEN: 'x'.repeat(24),
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('refuses a test database url that is not a test database', () => {
    expect(() =>
      parseEnv({
        ...base,
        TEST_DATABASE_URL: 'postgres://u:p@localhost:5432/sce',
      } as NodeJS.ProcessEnv),
    ).toThrow(/_test/);
  });
});

describe('clock', () => {
  it('fixedClock is deterministic', () => {
    const clock = fixedClock('2026-09-21T00:00:00Z');
    expect(clock().toISOString()).toBe(clock().toISOString());
  });
});
