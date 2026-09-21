#!/usr/bin/env bash
#
#  !!  DESTRUCTIVE  !!
#
#  Removes the containers AND the named volumes:
#    sce-postgres-data   every learning event, atom, draft, approval, publication and analytic
#    sce-redis-data      idempotency locks and rate-limit counters
#    sce-n8n-data        all n8n workflows and stored credentials
#    sce-ollama-models   downloaded models (several GB to re-download)
#
#  There is no undo. Take a backup first: infra/scripts/backup.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--force" ]; then
  echo "refusing to reset without --force."
  echo "usage: infra/scripts/reset.sh --force"
  echo "this destroys ALL local data (postgres, redis, n8n workflows/credentials, ollama models)."
  exit 1
fi

echo "This will PERMANENTLY DELETE all local data volumes for the sce stack."
read -r -p "Type 'DESTROY' to continue: " answer
[ "$answer" = "DESTROY" ] || { echo "aborted."; exit 1; }

if command -v docker >/dev/null 2>&1 && docker compose ps -q postgres >/dev/null 2>&1; then
  echo "==> taking a safety backup first"
  ./scripts/backup.sh || echo "backup failed or stack not running; continuing as instructed"
fi

docker compose --profile app down --volumes --remove-orphans
echo "Reset complete. Run infra/scripts/start.sh to rebuild from a clean state."
