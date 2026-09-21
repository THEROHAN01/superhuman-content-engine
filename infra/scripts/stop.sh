#!/usr/bin/env bash
# Stop the stack. Containers are removed; named volumes and their data are kept.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --profile app down --remove-orphans
echo "Stack stopped. Data volumes kept (use reset.sh --force to destroy them)."
