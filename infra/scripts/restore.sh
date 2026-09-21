#!/usr/bin/env bash
# Restore a dump produced by backup.sh into the running postgres container.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

dump="${1:-}"
[ -f "$dump" ] || { echo "usage: infra/scripts/restore.sh <backups/sce-*.sql.gz>"; exit 1; }

echo "This overwrites the current contents of database ${POSTGRES_DB:-sce}."
read -r -p "Type 'RESTORE' to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "aborted."; exit 1; }

gunzip -c "$dump" | docker compose exec -T postgres psql -U "${POSTGRES_USER:-sce}" -d "${POSTGRES_DB:-sce}" -v ON_ERROR_STOP=1
echo "restore complete; run 'pnpm db:migrate' to apply any newer migrations."
