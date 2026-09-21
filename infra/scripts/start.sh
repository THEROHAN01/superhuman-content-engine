#!/usr/bin/env bash
# Start the local stack. Infrastructure only by default; --with-app also builds api + workers.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "infra/.env is missing. Run: cp infra/.env.example infra/.env and fill it in."; exit 1; }

profiles=()
[ "${1:-}" = "--with-app" ] && profiles=(--profile app)

echo "==> starting stack${profiles:+ with application services}"
docker compose "${profiles[@]}" up -d --wait --wait-timeout 300

echo
echo "==> service state"
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

cat <<'INFO'

n8n        http://localhost:5678   (basic auth from infra/.env)
postgres   localhost:5432
redis      localhost:6379
ollama     http://localhost:11434
api        http://localhost:8080   (only with --with-app)

Next: pnpm db:migrate
INFO
