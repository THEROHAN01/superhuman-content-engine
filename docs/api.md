# HTTP API

Base URL: `http://localhost:8080` (configurable via `API_PORT` / `API_BIND`).

Every response carries `correlation_id`, echoed in the `x-correlation-id` header. Supply that
header to thread one id through a whole n8n pipeline; otherwise the API generates one.

Errors always look like:

```json
{
  "error": { "code": "E_INVALID_CAPTURE", "message": "...", "details": {} },
  "correlation_id": "cor_..."
}
```

## Authentication

When `CAPTURE_API_TOKEN` is set, capture endpoints require `Authorization: Bearer <token>`
(compared in constant time). Configuration validation refuses to start a non-loopback bind without
a token, so an unauthenticated API is necessarily local-only. Health probes are always open and
are never rate limited.

## Endpoints

### `POST /capture`

Records a learning event. The only required field is `text`.

```bash
curl -X POST localhost:8080/capture -H 'content-type: application/json' \
  -d '{"text":"Today I learned that SKIP LOCKED turns a Postgres table into a safe work queue.","tags":["postgres"]}'
```

| Field            | Required | Notes                                                              |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `text`           | yes      | 10-20000 chars; stored verbatim                                    |
| `title`          | no       | derived later if absent                                            |
| `source`         | no       | `http` (default), `telegram`, `notion`, `github`, `manual`, `seed` |
| `external_id`    | no       | provider-side id; deduplicates redeliveries                        |
| `captured_at`    | no       | ISO-8601; defaults to now                                          |
| `tags`           | no       | up to 10                                                           |
| `context`        | no       | free-form capture context - never credentials                      |
| `correlation_id` | no       | defaults to the request's correlation id                           |

Responses:

- `201` - created. `{ id, status, duplicate: false, message, captured_at, correlation_id }`
- `200` - **the same note was already captured**; the original id is returned with
  `duplicate: true` and nothing new is written. Retrying is always safe.
- `422` - payload failed validation; `details.issues` names the offending fields.
- `401` - missing/invalid bearer token when one is configured.
- `429` - rate limit (`API_RATE_LIMIT_PER_MINUTE`, default 120/min per IP).

Deduplication uses two independent rules, both enforced by unique indexes:
the canonical content hash of the text, and `(source, external_id)` when an external id is given.

### `GET /learning-events/:id`

Returns the stored event, including `raw_text`, `content_hash`, `classification` and
`correlation_id`. `404` with `E_NOT_FOUND` when unknown.

### `GET /learning-events?status=&limit=&since=`

Most recent first. `status` must be one of the declared learning-event statuses (`400`
`E_INVALID_STATUS` otherwise). `limit` is capped at 200.

### `GET /health/live`

Process liveness only; touches no dependency. Always `200` while the process runs.

### `GET /health/ready`

Checks the dependencies this process needs and reports the active provider configuration:

```json
{ "status": "ready", "checks": { "database": { "ok": true, "detail": "15ms" } },
  "config": { "publish_mode": "dry_run", "llm_provider": "mock", ... } }
```

`503` with `status: "degraded"` when a dependency is unusable.
