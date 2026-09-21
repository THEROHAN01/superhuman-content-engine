#!/usr/bin/env bash
# Tail logs for one service or all of them: infra/scripts/logs.sh [service]
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --profile app logs -f --tail=200 "$@"
