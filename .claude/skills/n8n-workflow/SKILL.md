---
name: n8n-workflow
description: Author, export, import, or review an n8n workflow JSON for this repository, following the naming, credential, correlation-id and idempotency conventions. Use whenever n8n/workflows/* changes or a new orchestration flow is needed.
---

# n8n workflow conventions

Workflows are **version-controlled artifacts** in `n8n/workflows/<domain>_<action>_v<N>.json`.
n8n is the orchestrator; business logic lives in the API (`apps/api`), not in Function nodes.
A workflow node should call an HTTP endpoint we own and test, rather than re-implementing logic.

## Naming

- Workflow name and file: `domain_action_v1` (e.g. `learning_normalize_v1`, `content_generate_v1`).
- Webhook path: `/webhook/sce/<domain>/<action>` — versioned by the workflow name, not the path.
- Credentials: `sce_<service>_<env>` (e.g. `sce_postgres_local`). **Never** export credential
  values; `n8n/credentials/` holds `.example.json` shapes only.

## Required in every workflow

1. First node normalizes the input and ensures `correlation_id` exists (generate if absent).
2. Every HTTP Request node: explicit timeout, `Retry On Fail` with backoff, `onError` set to
   continue to an error branch — never silently ignore.
3. The error branch posts to the shared error workflow (`system_error_handler_v1`) with
   `{workflow, node, correlation_id, payload_summary, error}`.
4. Any node that writes must be idempotent: call an endpoint that accepts an idempotency key, or
   `INSERT ... ON CONFLICT DO NOTHING`.
5. No secrets in node parameters — use credentials or `$env`.

## Export / import

```bash
# export from a running n8n (writes one file per workflow)
infra/scripts/n8n-export.sh
# import into a fresh n8n
infra/scripts/n8n-import.sh
```

After exporting, strip volatile fields (`versionId`, `meta.instanceId`, `updatedAt`, `pinData`)
— `infra/scripts/n8n-export.sh` does this; verify the diff is semantic only.

Update `docs/workflows.md` (the catalog: name, trigger, inputs, outputs, failure path, credentials)
in the same commit.
