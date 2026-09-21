#!/usr/bin/env bash
# PreToolUse(Bash) for `git commit`: refuse commits that carry secrets or obvious debris.
set -uo pipefail
cmd="$(cat | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"
grep -qE '\bgit +commit\b' <<<"$cmd" || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0

staged="$(git diff --cached --name-only 2>/dev/null)"
[ -z "$staged" ] && exit 0

if grep -qxE '(.*/)?\.env(\..*)?$' <<<"$staged" && ! grep -qxE '.*\.env\.example$' <<<"$staged"; then
  echo "BLOCKED: a .env file is staged. Unstage it (git restore --staged <file>) — only .env.example belongs in Git." >&2
  exit 2
fi

if git diff --cached -U0 | grep -qE '^\+.*(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,})'; then
  echo "BLOCKED: staged changes contain a credential-shaped literal. Remove it and read secrets from the environment." >&2
  exit 2
fi
exit 0
