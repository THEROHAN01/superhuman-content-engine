#!/usr/bin/env bash
# Import the version-controlled workflows into the running n8n.
# Credentials are NOT imported - create them once in the UI (see n8n/README.md).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> copying workflows into the n8n container"
docker compose exec -T n8n sh -c 'rm -rf /tmp/sce-import && mkdir -p /tmp/sce-import'
for file in ../n8n/workflows/*.json; do
  name="$(basename "$file")"
  docker compose exec -T n8n sh -c "cat > /tmp/sce-import/$name" < "$file"
done

echo "==> importing"
docker compose exec -T n8n n8n import:workflow --separate --input=/tmp/sce-import

cat <<'INFO'

Imported. Remaining manual steps (values never live in Git):
  1. Create credentials in the n8n UI: sce_postgres_local, sce_api_token, sce_telegram_bot
  2. Open each workflow and confirm its credential selection
  3. Activate the workflows you want running
INFO
