#!/usr/bin/env bash
# PreToolUse guard for Bash. Blocks irreversible or policy-violating commands.
set -uo pipefail

cmd="$(cat | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

block() { echo "BLOCKED: $1" >&2; exit 2; }

# Force-push / history rewrite on shared branches
grep -qE 'git +push[^|;&]*(--force(-with-lease)?|[[:space:]]-f([[:space:]]|$))' <<<"$cmd" && \
  grep -qE '(main|master|origin/(main|master))' <<<"$cmd" && \
  block "force-pushing to a shared branch. Push to the feature branch normally."

# Bypassing verification
grep -qE 'git +commit[^|;&]*--no-verify' <<<"$cmd" && \
  block "git commit --no-verify skips the repo's checks. Run 'pnpm verify' and fix the failures."

# Destroying local data volumes without going through the documented script
grep -qE 'docker +compose[^|;&]*down[^|;&]*(-v|--volumes)' <<<"$cmd" && \
  ! grep -q 'infra/scripts/reset.sh' <<<"$cmd" && \
  block "'docker compose down -v' deletes the Postgres/n8n/Ollama volumes. Use infra/scripts/reset.sh, which warns and confirms first."

grep -qE '\brm +-[a-zA-Z]*r[a-zA-Z]* +/( |$)' <<<"$cmd" && block "recursive delete of /."
grep -qE '\b(dropdb|DROP +DATABASE)\b' <<<"$cmd" && ! grep -qiE '(test|check|tmp|_ci)' <<<"$cmd" && \
  block "dropping a non-test database. Test databases must be named *_test/*_check."

# Real publishing during development
grep -qE 'PUBLISH_MODE=live' <<<"$cmd" && \
  block "PUBLISH_MODE=live publishes real social content. Development runs in dry_run/mock (CLAUDE.md rule 2)."

# Wrong package manager
grep -qE '^\s*(npm|yarn) +(install|add|i)\b' <<<"$cmd" && \
  block "this workspace uses pnpm. Use 'pnpm add' / 'pnpm install'."

exit 0
