---
name: external-adapter
description: Add or modify an external service adapter (LLM/Ollama, Postiz publishing, Telegram, research/search, GitHub) with mock-first defaults, timeouts, retries, idempotency and documented assumptions. Use whenever code talks to a third-party API.
---

# External adapter procedure

**Never invent an external API.** If the contract is not verified against official documentation
you have actually read, implement it behind the interface, default to `mock`, and record the
assumption in `docs/external-apis.md` with a "VERIFY BEFORE LIVE USE" marker.

## Shape

```
packages/adapters/src/<domain>/
  types.ts        # the interface + typed result/failure unions
  mock.ts         # deterministic, offline, used by tests and dev defaults
  <provider>.ts   # real implementation
  failing.ts      # always-fails provider, used to test error paths
  index.ts        # createXAdapter(env) -> picks provider from config
```

## Requirements

1. Provider chosen by env (`X_PROVIDER=mock|<provider>|failing`), default `mock` everywhere
   except an explicit production config.
2. `AbortSignal.timeout(env.X_TIMEOUT_MS)` on every fetch. No unbounded waits.
3. Retries only for transient failures (network, 429, 5xx) via `withRetry` from `@sce/utils`:
   bounded attempts, exponential backoff with jitter, respects `Retry-After`.
4. Return a discriminated union (`{ok: true, ...} | {ok: false, kind: 'transient'|'permanent',
...}`) — do not throw across the boundary for expected failures.
5. Never log request/response bodies containing credentials; log status, duration, attempt count,
   correlation id.
6. Write operations take an idempotency key and the caller records the external id.
7. Unit-test with a fake `fetch`: success, timeout, 429 + Retry-After, 5xx retry-then-succeed,
   permanent 4xx, malformed body.

## Documentation

Add a row to `docs/external-apis.md`: service, provider id, endpoints used, auth mechanism,
rate limits, verified/assumed, required env vars, failure semantics.
