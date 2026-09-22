# Launch checklist

What must be true before this repository is pointed at a real Telegram chat, a real Postiz
account, or a real social platform. Everything here is verifiable - run the command, read the
output. Nothing on this list is "should be fine".

The system ships safe: every provider defaults to `mock` and `PUBLISH_MODE` defaults to `dry_run`.
Going live is a deliberate sequence of steps, and each one is listed below.

## 1. The repository is healthy

- [ ] `pnpm install` succeeds on Node 22 with pnpm 10.
- [ ] `TEST_DATABASE_URL=... pnpm verify` is green - typecheck, lint and the full suite including
      the database and end-to-end tests. A green run with DB suites _skipped_ does not count; the
      summary must show them running.
- [ ] `git status` is clean and `git log` describes what changed.
- [ ] No secret is committed: `git grep -nE '(api[_-]?key|secret|token|password)\s*[:=]\s*["\x27][^"\x27]{8,}'`
      returns only placeholders, test fixtures and documentation.
- [ ] `infra/.env` exists locally and is **not** tracked (`git check-ignore infra/.env`).

## 2. The whole path works here

- [ ] `RESEARCH_PROVIDER=fixture pnpm dev:api` boots and `/health/ready` reports
      `publish_mode: dry_run`.
- [ ] `infra/scripts/demo.sh` walks capture -> atom -> research -> ideas -> five drafts -> gate ->
      approval -> publication -> analytics -> weekly report, and its replay section shows one
      publication and one analytics row.
- [ ] `infra/scripts/failure-drill.sh` passes every check.
- [ ] `SELECT count(*) FROM error_events` is 0 after a clean demo run, and `/health/system` reports
      `healthy`.

## 3. Data and backups

- [ ] `pnpm db:migrate` is idempotent: running it twice applies nothing the second time.
- [ ] `infra/scripts/backup-verify.sh` takes a backup **and restores it**; a backup that has never
      been restored is not a backup.
- [ ] The restore drill is scheduled, not aspirational - write down when it is next due.

## 4. Before the first real credential

For each provider being switched on, in this order:

- [ ] Read the contract in `docs/external-apis.md` and confirm the rows marked **assumed** against
      the provider's current documentation. Postiz, SearxNG and Telegram analytics are recorded
      there as assumptions verified only against their mock.
- [ ] Put the credential in `infra/.env` only. Never in a workflow JSON, a test fixture, a commit
      message or a log line.
- [ ] Start with the _read_ path (research, analytics) before the _write_ path (publishing).
- [ ] Confirm pino redaction covers the new field if it carries a secret
      (`packages/utils/src/logger.ts`).

## 5. Telegram

- [ ] `TELEGRAM_PROVIDER=telegram` with `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and
      `TELEGRAM_WEBHOOK_SECRET` set - the API refuses to boot without all three.
- [ ] `pnpm --filter @sce/bot start set-webhook` registers the webhook over HTTPS.
- [ ] An update _without_ the secret-token header is rejected with 401.
- [ ] A real approval card arrives, its buttons work, and pressing the same button twice records
      one decision (`SELECT count(*) FROM approvals WHERE action_id = ...` is 1).

## 6. Publishing - the last switch

- [ ] `PUBLISHING_PROVIDER=postiz` with `POSTIZ_BASE_URL` and `POSTIZ_API_KEY`, still in
      `PUBLISH_MODE=dry_run`. Confirm a scheduled item records `dry_run = true` and no post exists
      in the Postiz account.
- [ ] Only then set `PUBLISH_MODE=live`, and only against a test account first. The API refuses
      live mode with any provider other than `postiz`.
- [ ] Publish exactly one approved item. Check the platform, then check
      `SELECT id, status, dry_run, external_id FROM publications ORDER BY created_at DESC LIMIT 1`.
- [ ] Try to publish content that is not `approved` and confirm it is refused (`E_NOT_APPROVED`).
- [ ] Decide and write down who may flip `PUBLISH_MODE`, and where that is recorded.

## 7. Operations

- [ ] The workers process is running (`pnpm dev:worker` or the compose `app` profile) so analytics,
      the weekly report and the hourly sweep actually happen.
- [ ] `/health/system` is monitored, not just available - it is the endpoint that distinguishes
      "up" from "making progress".
- [ ] `docs/incident-runbook.md` has been read once _before_ it is needed.
- [ ] n8n workflows are imported (`infra/scripts/n8n-import.sh`) and their credentials configured
      in n8n itself - never in the exported JSON.

## 8. Known limitations to accept explicitly

- [ ] Postiz, SearxNG and Telegram analytics contracts are **unverified against the live services**
      (`docs/external-apis.md`). The adapters are written to a documented assumption and default to
      mocks.
- [ ] The `fixture` research corpus is curated reference material, not search results, and is
      refused in production.
- [ ] Analytics from the mock provider are synthetic and marked as such on every row
      (`raw_payload.note`); they must never be read as real performance data.
- [ ] Docker Compose has been validated statically but not started in the build environment; the
      first `infra/scripts/start.sh` on a Docker host is itself a verification step.
