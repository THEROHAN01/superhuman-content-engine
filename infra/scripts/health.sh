#!/usr/bin/env bash
# Check each service individually and report a single pass/fail summary.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

fail=0
check() { # name, command
  if eval "$2" >/dev/null 2>&1; then printf '  %-10s OK\n' "$1"; else printf '  %-10s FAIL\n' "$1"; fail=1; fi
}

echo "service health:"
check postgres "docker compose exec -T postgres pg_isready -U ${POSTGRES_USER:-sce} -d ${POSTGRES_DB:-sce}"
check redis    "docker compose exec -T redis redis-cli ping"
check n8n      "curl -fsS http://localhost:${N8N_PORT:-5678}/healthz"
check ollama   "curl -fsS http://localhost:${OLLAMA_PORT:-11434}/api/tags"
check api      "curl -fsS http://localhost:${API_PORT:-8080}/health/ready"

[ "$fail" -eq 0 ] && echo "all services healthy" || echo "one or more services unhealthy"
exit "$fail"
