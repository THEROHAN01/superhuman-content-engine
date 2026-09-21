#!/usr/bin/env bash
# SessionStart: make the workspace usable immediately and report what is actually running.
set -uo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

echo "== Superhuman Content Engine =="
echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)  head: $(git log -1 --oneline 2>/dev/null || echo 'no commits')"

if [ -f package.json ] && [ ! -d node_modules ]; then
  echo "installing workspace dependencies (pnpm install --frozen-lockfile)..."
  corepack pnpm install --frozen-lockfile >/tmp/sce-pnpm-install.log 2>&1 \
    || pnpm install >/tmp/sce-pnpm-install.log 2>&1 \
    || echo "  pnpm install failed — see /tmp/sce-pnpm-install.log"
fi

# Local PostgreSQL makes the DB-backed tests runnable without Docker.
if command -v pg_ctlcluster >/dev/null 2>&1 && ! pg_isready -q 2>/dev/null; then
  pg_ctlcluster 16 main start >/dev/null 2>&1 || true
fi
pg_isready -q 2>/dev/null && echo "postgres: ready ($(psql -tAX "${DATABASE_URL:-postgres://postgres@localhost/postgres}" -c 'select current_database()' 2>/dev/null || echo 'set DATABASE_URL'))" || echo "postgres: not running (DB tests will skip)"
command -v redis-server >/dev/null 2>&1 && { redis-cli ping >/dev/null 2>&1 && echo "redis: ready" || { redis-server --daemonize yes >/dev/null 2>&1 && echo "redis: started"; }; }

echo "next milestone: $(ls docs/milestones/*.md 2>/dev/null | tail -1 | xargs -r basename || echo '01 — see docs/build-plan.md')"
echo "run 'pnpm verify' before committing. Rules: CLAUDE.md"
