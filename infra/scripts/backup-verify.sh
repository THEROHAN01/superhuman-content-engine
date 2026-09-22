#!/usr/bin/env bash
#
# Backup AND restore drill.
#
# A backup nobody has restored is a hope, not a backup. This script takes a dump, restores it into
# a scratch database, and compares row counts table by table. It never touches the live database.
#
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

SOURCE_DB="${POSTGRES_DB:-sce}"
SCRATCH_DB="${SOURCE_DB}_restore_check"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="backups/verify-${STAMP}.sql.gz"
mkdir -p backups

psql_exec() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-sce}" -v ON_ERROR_STOP=1 "$@"; }

echo "==> dumping ${SOURCE_DB}"
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-sce}" -d "$SOURCE_DB" --no-owner | gzip > "$DUMP"
echo "    $(du -h "$DUMP" | cut -f1)"

echo "==> restoring into ${SCRATCH_DB} (scratch; the live database is untouched)"
psql_exec -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}" >/dev/null
psql_exec -d postgres -c "CREATE DATABASE ${SCRATCH_DB}" >/dev/null
gunzip -c "$DUMP" | docker compose exec -T postgres psql -U "${POSTGRES_USER:-sce}" -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 >/dev/null

echo "==> comparing row counts"
TABLES="learning_events content_atoms source_documents content_ideas content_items approvals publications analytics_events weekly_reports workflow_runs error_events jobs webhook_deliveries"
failed=0
for table in $TABLES; do
  live=$(psql_exec -d "$SOURCE_DB" -tAc "SELECT count(*) FROM ${table}" | tr -d '[:space:]')
  restored=$(psql_exec -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM ${table}" | tr -d '[:space:]')
  if [ "$live" = "$restored" ]; then
    printf '    %-20s %s rows  OK\n' "$table" "$live"
  else
    printf '    %-20s live=%s restored=%s  MISMATCH\n' "$table" "$live" "$restored"
    failed=1
  fi
done

echo "==> dropping the scratch database"
psql_exec -d postgres -c "DROP DATABASE ${SCRATCH_DB}" >/dev/null

if [ "$failed" -eq 0 ]; then
  echo "restore verified: ${DUMP} restores to an identical row count in every table"
else
  echo "RESTORE VERIFICATION FAILED - do not rely on this backup"
  exit 1
fi
