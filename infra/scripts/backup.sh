#!/usr/bin/env bash
# Dump the application database to infra/backups/. Safe to run while the stack is up.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

out="backups/sce-$(date +%Y%m%d-%H%M%S).sql.gz"
mkdir -p backups
echo "==> dumping ${POSTGRES_DB:-sce} to infra/$out"
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-sce}" -d "${POSTGRES_DB:-sce}" --no-owner \
  | gzip > "$out"
echo "==> $(du -h "$out" | cut -f1) written"
echo "restore with: infra/scripts/restore.sh $out"
