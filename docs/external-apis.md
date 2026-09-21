# External APIs

Every external service sits behind an adapter with three implementations: `mock` (deterministic,
offline, the default), the real provider, and `failing` (always errors, for drills and error-path
tests). Provider choice is configuration, never a code branch at the call site.

**Verified** means the request/response shape was checked against the provider's official
documentation. **Assumed** means it is implemented to the best available understanding and
**must be confirmed against a live sandbox before enabling live mode**.

| Service  | Provider id | Endpoints used                                                                                                  | Auth                      | Status                                             | Env vars                                                            | Failure semantics                                                                              |
| -------- | ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Ollama   | `ollama`    | `POST {base}/api/chat` with `{model, messages, stream:false, format?:'json', options}` -> `{message:{content}}` | none (local)              | verified against Ollama's documented chat API      | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`              | network/timeout/5xx/429 -> transient; 4xx, empty completion, non-JSON, off-schema -> permanent |
| Postiz   | `postiz`    | not implemented yet (Milestone 13)                                                                              | API key header            | assumed                                            | `POSTIZ_BASE_URL`, `POSTIZ_API_KEY`                                 | -                                                                                              |
| Telegram | `telegram`  | not implemented yet (Milestone 12)                                                                              | bot token in path         | assumed                                            | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | -                                                                                              |
| SearxNG  | `searxng`   | not implemented yet (Milestone 07)                                                                              | none / instance dependent | assumed                                            | `SEARXNG_BASE_URL`                                                  | -                                                                                              |
| GitHub   | webhook     | inbound only (Milestone 14)                                                                                     | HMAC-SHA256 signature     | verified (documented header `X-Hub-Signature-256`) | `GITHUB_WEBHOOK_SECRET`                                             | invalid signature -> 401, never processed                                                      |

## Rules for every adapter

1. Explicit timeout on every request (`AbortSignal.timeout`). No unbounded waits.
2. Failures are typed: `transient` (network, timeout, 429, 5xx) may be retried with bounded
   exponential backoff; `permanent` (4xx, schema violation) never is.
3. No credentials in URLs, logs, or stored provider metadata.
4. Write operations take an idempotency key and the caller stores the returned external id.
5. Every adapter has unit tests driven by a fake `fetch`: success, timeout, 429, 5xx, permanent
   4xx, and malformed body.

## Model output handling

LLM calls that expect structured output go through `completeJson`, which parses the completion
(tolerating fenced or prefixed JSON) and validates it against a zod schema. A malformed or
off-schema answer is a **permanent** failure recorded as such - it is never coerced, repaired, or
silently replaced with a default. That is what keeps a failed classification from looking like a
successful one.
